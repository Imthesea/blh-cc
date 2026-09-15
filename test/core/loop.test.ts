import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, lastAssistantText, parseToolArguments } from "../../src/core/loop.js";
import { Harness } from "../../src/core/harness.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { HookBus, PRE_TOOL_USE } from "../../src/core/hooks.js";
import { ContextCompactor } from "../../src/compaction/compactor.js";
import { MockProvider, makeToolCallMessage, makeTextMessage } from "../integration/helpers.js";
import type { ChatMessage, ChatProvider, Config, ToolDefinition } from "../../src/core/types.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeHarness(
  script: ChatMessage[],
  options: {
    hooks?: HookBus;
    tools?: ToolDefinition[];
    compactor?: ContextCompactor;
    provider?: ChatProvider;
  } = {},
) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object" },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  for (const tool of options.tools ?? []) tools.register(tool);
  return new Harness(
    config,
    options.provider ?? new MockProvider(script),
    tools,
    options.hooks ?? new HookBus(),
    options.compactor,
  );
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
      { hooks },
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

class FlakyProvider implements ChatProvider {
  calls = 0;
  private readonly script: (ChatMessage | Error)[];

  constructor(script: (ChatMessage | Error)[]) {
    this.script = [...script];
  }

  async chat(_messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatMessage> {
    this.calls += 1;
    const action = this.script.shift();
    if (!action) throw new Error("FlakyProvider exhausted");
    if (action instanceof Error) throw action;
    return action;
  }
}

class FakePromptTooLong extends Error {
  readonly status = 400;
}

function makeCompactor(tmpDir: string, provider?: ChatProvider): ContextCompactor {
  return new ContextCompactor({
    provider: provider ?? new MockProvider([]),
    transcriptDir: path.join(tmpDir, ".transcripts"),
    toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
  });
}

describe("agentLoop 压缩集成", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "loop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runTurn 把 activeRequest 传给 prepare", async () => {
    const compactor = makeCompactor(tmpDir);
    let seenRequest = "";
    compactor.prepare = async (messages, request) => {
      seenRequest = request;
      return messages;
    };
    const harness = makeHarness([makeTextMessage("done")], { compactor });
    const messages = harness.newSession();
    await harness.runTurn(messages, "fix the bug");
    expect(seenRequest).toBe("fix the bug");
  });

  it("反应式压缩后重试一次", async () => {
    const provider = new FlakyProvider([
      new FakePromptTooLong("Error: prompt_too_long"),
      { role: "assistant", content: "summary of old" },
      makeTextMessage("recovered"),
    ]);
    // compactor 与 harness 共享同一 provider：摘要调用消耗同一脚本
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { compactor, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "hi");
    expect(provider.calls).toBe(3);
    expect(lastAssistantText(messages)).toBe("recovered");
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content?.startsWith("[Reactive compact]")).toBe(true);
  });

  it("重试耗尽后原样抛出", async () => {
    const provider = new FlakyProvider([
      new FakePromptTooLong("prompt_too_long"),
      { role: "assistant", content: "summary" },
      new FakePromptTooLong("still prompt_too_long"),
    ]);
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { compactor, provider });
    await expect(harness.runTurn(harness.newSession(), "hi")).rejects.toBeInstanceOf(
      FakePromptTooLong,
    );
    expect(provider.calls).toBe(3);
  });

  it("非上下文错误不触发压缩直接抛出", async () => {
    const provider = new FlakyProvider([new Error("boom")]);
    const compactor = makeCompactor(tmpDir);
    const harness = makeHarness([], { compactor, provider });
    await expect(harness.runTurn(harness.newSession(), "hi")).rejects.toThrow("boom");
    expect(provider.calls).toBe(1);
  });

  it("compact 工具在批次闭合后压缩", async () => {
    const sideEffects: string[] = [];
    const tools: ToolDefinition[] = [
      {
        name: "write_note",
        description: "",
        parameters: { type: "object", properties: { text: { type: "string" } } },
        handler: async (args) => {
          sideEffects.push(String(args.text));
          return "noted";
        },
      },
    ];
    const batch: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "write_note", arguments: JSON.stringify({ text: "hello" }) },
        },
        { id: "c2", type: "function", function: { name: "compact", arguments: "{}" } },
      ],
    };
    const provider = new MockProvider([
      batch,
      { role: "assistant", content: "conversation summary" },
      makeTextMessage("done"),
    ]);
    const compactor = makeCompactor(tmpDir, provider);
    const harness = makeHarness([], { tools, compactor, provider });
    const messages = harness.newSession();
    await harness.runTurn(messages, "note then compact");
    // 同批 write_note 的副作用在压缩前完成，不丢失
    expect(sideEffects).toEqual(["hello"]);
    expect(messages).toHaveLength(3); // system + [Compacted] 摘要 + 最终答复
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content?.startsWith("[Compacted]")).toBe(true);
    expect(messages[1]?.content).toContain(
      "Current user request:\nnote then compact",
    );
    expect(messages[1]?.content).toContain("conversation summary");
    const transcripts = readdirSync(path.join(tmpDir, ".transcripts")).filter((f) =>
      f.endsWith(".jsonl"),
    );
    expect(transcripts.length).toBeGreaterThan(0);
  });

  it("systemPrompt 包含压缩消息防护指引", () => {
    const harness = makeHarness([]);
    expect(harness.systemPrompt).toContain("Conversation summary");
  });
});
