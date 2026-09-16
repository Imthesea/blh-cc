import { PassThrough } from "node:stream";
import readline from "node:readline";
import { describe, it, expect } from "vitest";
import { repl, makeReadlineIO } from "../../src/cli/repl.js";
import { Harness } from "../../src/core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { makePermissionHook } from "../../src/security/approval.js";
import { DEFAULT_RULES } from "../../src/security/rules.js";
import {
  MockProvider,
  makeTextMessage,
  makeToolCallMessage,
} from "../integration/helpers.js";
import type { Config } from "../../src/core/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: ".",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function askUser(rl: readline.Interface): (prompt: string) => Promise<string> {
  return (prompt) =>
    new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("repl readline 复用", () => {
  it("权限询问复用同一 readline 接口,询问后仍可继续输入", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rl = readline.createInterface({ input: stdin, output: stdout });

    const provider = new MockProvider([
      makeToolCallMessage("bash", { command: "echo hi" }),
      makeTextMessage("done"),
    ]);
    const tools = new ToolRegistry();
    registerBuiltinTools(tools, config);
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, (payload) =>
      makePermissionHook(DEFAULT_RULES, askUser(rl))(payload.name, payload.input),
    );
    const harness = new Harness(config, provider, tools, hooks);

    const printed: string[] = [];
    const base = makeReadlineIO(rl);
    const done = repl(harness, {
      readLine: base.readLine,
      print: (text: string) => {
        printed.push(text);
      },
    });

    // 收集 readline 写出的提示,按提示逐步喂入(模拟真实用户在提示后输入)
    let out = "";
    stdout.on("data", (chunk) => {
      out += chunk.toString();
    });

    await waitFor(() => out.includes("> "));
    stdin.write("run echo\n");

    await waitFor(() => out.includes("allow bash(echo hi)? [y/N] "));
    stdin.write("y\n");

    await waitFor(() => (out.match(/> /g) ?? []).length >= 2);
    stdin.write("exit\n");

    await done;
    stdin.end();
    rl.close();

    expect(printed).toContain("done");
  });
});
