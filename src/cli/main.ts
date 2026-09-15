#!/usr/bin/env node
import readline from "node:readline";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../core/config.js";
import { ContextCompactor } from "../compaction/compactor.js";
import { registerCompactTool } from "../compaction/compactTool.js";
import { Harness } from "../core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../core/hooks.js";
import { lastAssistantText } from "../core/loop.js";
import { OpenAIProvider } from "../providers/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/index.js";
import { DEFAULT_RULES } from "../security/rules.js";
import { makePermissionHook } from "../security/approval.js";
import { repl, makeReadlineIO } from "./repl.js";
import { TaskStore } from "../planning/tasks.js";
import { TodoManager } from "../planning/todo.js";
import { registerPlanningTools } from "../planning/tools.js";

export function buildHarness(workdir?: string): Harness {
  const config = loadConfig(workdir);
  const provider = new OpenAIProvider(config);
  const tools = new ToolRegistry();
  const hooks = new HookBus();
  registerBuiltinTools(tools, config);
  const permissionHook = makePermissionHook(DEFAULT_RULES, async (prompt) => {
    const readlineInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise<string>((resolve) =>
      readlineInterface.question(prompt, (answer) => {
        readlineInterface.close();
        resolve(answer);
      }),
    );
  });
  hooks.register(PRE_TOOL_USE, (payload) => permissionHook(payload.name, payload.input));
  registerCompactTool(tools);
  const todoManager = new TodoManager();
  const taskStore = new TaskStore(path.join(config.workdir, ".tasks"));
  registerPlanningTools(tools, todoManager, taskStore);
  const compactor = new ContextCompactor({
    provider,
    transcriptDir: path.join(config.workdir, ".transcripts"),
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
    notify: (message) => console.log(message),
  });
  return new Harness(config, provider, tools, hooks, compactor, todoManager);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const harness = buildHarness();
  const printFlagIndex = args.findIndex((arg) => arg === "-p" || arg === "--print");
  if (printFlagIndex !== -1) {
    const text = args[printFlagIndex + 1];
    if (!text) {
      console.error("usage: blh -p <text>");
      process.exit(1);
    }
    const messages = harness.newSession();
    await harness.runTurn(messages, text);
    console.log(lastAssistantText(messages));
    return;
  }
  await repl(harness, makeReadlineIO());
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
