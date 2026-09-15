import { describe, it, expect } from "vitest";
import { agentLoop, lastAssistantText, parseToolArguments } from "../../src/core/loop.js";
import { Harness } from "../../src/core/harness.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "../integration/helpers.js";
import type { ChatMessage, Config } from "../../src/core/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeHarness(script: ChatMessage[], hooks?: HookBus) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  return new Harness(config, new MockProvider(script), tools, hooks ?? new HookBus());
}

describe("parseToolArguments", () => {
  it("parses valid JSON object", () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
  });
  it("returns {} for invalid JSON or non-object", () => {
    expect(parseToolArguments("not json")).toEqual({});
    expect(parseToolArguments('"[1,2]"')).toEqual({});
    expect(parseToolArguments('"42"')).toEqual({});
  });
});

describe("agentLoop", () => {
  it("runs one tool call then stops on text", async () => {
    const harness = makeHarness([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages);
    // user + assistant(tool_call) + tool result + assistant(text)
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "echoed:hi",
    });
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("blocked by PreToolUse hook: appends blocked text, skips dispatch and post hook", async () => {
    const hooks = new HookBus();
    hooks.register(PRE_TOOL_USE, async () => "denied by user");
    const harness = makeHarness(
      [makeToolCallMessage("echo", { text: "hi" }), makeTextMessage("ok")],
      hooks,
    );
    // 包装 dispatch 计数
    let dispatched = 0;
    const originalDispatch = harness.tools.dispatch.bind(harness.tools);
    harness.tools.dispatch = async (name, args) => {
      dispatched += 1;
      return originalDispatch(name, args);
    };
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await agentLoop(harness, messages);
    expect(dispatched).toBe(0);
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "denied by user",
    });
  });
});

describe("lastAssistantText", () => {
  it("finds last non-empty assistant content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "first" },
      { role: "user", content: "x" },
      { role: "assistant", content: "second" },
    ];
    expect(lastAssistantText(messages)).toBe("second");
  });
  it("returns empty string when none", () => {
    expect(lastAssistantText([{ role: "user", content: "x" }])).toBe("");
  });
});
