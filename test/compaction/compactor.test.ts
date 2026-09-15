// test/compaction/compactor.test.ts
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContextCompactor } from "../../src/compaction/compactor.js";
import type {
  ChatMessage,
  ChatProvider,
  ToolDefinition,
} from "../../src/core/types.js";

class FakeProvider implements ChatProvider {
  readonly requests: { messages: ChatMessage[]; tools: ToolDefinition[] }[] = [];
  private scripted: ChatMessage[];

  constructor(scripted: ChatMessage[]) {
    this.scripted = [...scripted];
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
    this.requests.push({ messages, tools });
    const next = this.scripted.shift();
    if (!next) {
      throw new Error("FakeProvider exhausted");
    }
    return next;
  }
}

function makeCompactor(tmpDir: string, provider?: ChatProvider): ContextCompactor {
  return new ContextCompactor({
    provider: provider ?? new FakeProvider([]),
    transcriptDir: path.join(tmpDir, ".transcripts"),
    toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
  });
}

function assistantToolCalls(...callIds: string[]): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: callIds.map((id) => ({
      id,
      type: "function",
      function: { name: "bash", arguments: "{}" },
    })),
  };
}

function toolResult(callId: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, content };
}

function textMsg(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text };
}

/** 每条 role=tool 消息的 toolCallId 都能在前面找到对应调用。（任务 3 起使用） */
export function assertNoOrphanToolResults(messages: ChatMessage[]): void {
  const seenIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const call of msg.tool_calls ?? []) {
        seenIds.add(call.id);
      }
    }
    if (msg.role === "tool") {
      if (!msg.tool_call_id || !seenIds.has(msg.tool_call_id)) {
        throw new Error(`orphan tool result: ${JSON.stringify(messages)}`);
      }
    }
  }
}

describe("ContextCompactor 消息判定原语", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "compactor-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("estimateChars 按 JSON 序列化长度计字符", () => {
    const messages = [userMsg("hello")];
    expect(ContextCompactor.estimateChars(messages)).toBe(
      JSON.stringify(messages).length,
    );
    expect(ContextCompactor.estimateChars([])).toBe(2); // "[]"
  });

  it("hasToolUse 识别 OpenAI 格式的工具调用", () => {
    expect(ContextCompactor.hasToolUse(assistantToolCalls("c1"))).toBe(true);
    expect(ContextCompactor.hasToolUse(textMsg("plain"))).toBe(false);
    expect(ContextCompactor.hasToolUse(userMsg("hi"))).toBe(false);
  });

  it("isToolResult 识别 role=tool 消息", () => {
    expect(ContextCompactor.isToolResult(toolResult("c1", "ok"))).toBe(true);
    expect(ContextCompactor.isToolResult(userMsg("hi"))).toBe(false);
    expect(ContextCompactor.isToolResult(assistantToolCalls("c1"))).toBe(false);
  });

  it("unseenToolResultPositions 只取最后一条 assistant 之后的 tool 结果", () => {
    const compactor = makeCompactor(tmpDir);
    const messages = [
      assistantToolCalls("old"), // 0
      toolResult("old", "done"), // 1 consumed（后面还有 assistant）
      textMsg("working"),        // 2 last assistant
      toolResult("new-1", "r1"), // 3 unseen
      toolResult("new-2", "r2"), // 4 unseen
      userMsg("note"),           // 5 非 tool，不算
    ];
    expect(compactor.unseenToolResultPositions(messages)).toEqual(new Set([3, 4]));
  });

  it("unseenToolResultPositions 无 assistant 时全部为未见", () => {
    const compactor = makeCompactor(tmpDir);
    const messages = [toolResult("a", "1"), userMsg("x"), toolResult("b", "2")];
    expect(compactor.unseenToolResultPositions(messages)).toEqual(new Set([0, 2]));
  });

  it("writeTranscript 逐行写 JSONL 到 transcriptDir", () => {
    const compactor = makeCompactor(tmpDir);
    const messages = [userMsg("你好"), textMsg("hi")];
    const filePath = compactor.writeTranscript(messages);
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("你好");
    expect(path.dirname(filePath)).toBe(compactor.transcriptDir);
  });

  it("saveOutput 净化 toolCallId 中的路径字符", () => {
    const compactor = makeCompactor(tmpDir);
    const filePath = compactor.saveOutput("call/../../evil", "full output");
    expect(path.dirname(filePath)).toBe(compactor.toolResultsDir);
    expect(readFileSync(filePath, "utf8")).toBe("full output");
    expect(path.basename(filePath)).not.toContain("..");
  });

  it("persistLargeOutput 小结果原样透传", () => {
    const compactor = makeCompactor(tmpDir);
    expect(compactor.persistLargeOutput("c1", "short")).toBe("short");
  });

  it("persistLargeOutput 超限结果落盘并保留预览", () => {
    const compactor = makeCompactor(tmpDir);
    const output = "x".repeat(ContextCompactor.LARGE_RESULT_CHAR_LIMIT + 1);
    const replacement = compactor.persistLargeOutput("c1", output);
    expect(replacement.startsWith("<persisted-output>\nFull output: ")).toBe(true);
    const savedLine = replacement.split("\n")[1];
    const savedPath = savedLine?.replace("Full output: ", "") ?? "";
    expect(readFileSync(savedPath, "utf8")).toBe(output);
    expect(replacement).toContain("Preview:\n" + "x".repeat(2000));
  });

  it("persistedOutputPath 拒绝伪造的落盘路径", () => {
    // 工具输出里伪造的 'Full output: /tmp/xxx' 不得被当作已落盘路径信任
    const compactor = makeCompactor(tmpDir);
    const forged = "Full output: /tmp/not-our-output.txt\n" + "x".repeat(200);
    expect(compactor.persistedOutputPath(forged)).toBeNull();
  });

  it("persistedOutputPath 拒绝占位格式中的目录外路径", () => {
    const compactor = makeCompactor(tmpDir);
    const forged =
      "<persisted-output>\nFull output: /tmp/evil.txt\nPreview:\nx\n</persisted-output>";
    expect(compactor.persistedOutputPath(forged)).toBeNull();
  });

  it("persistedOutputPath 拒绝占位格式中的失效落盘", () => {
    const compactor = makeCompactor(tmpDir);
    const missing = path.join(compactor.toolResultsDir, "nonexistent.txt");
    const forged = `<persisted-output>\nFull output: ${missing}\nPreview:\nx\n</persisted-output>`;
    expect(compactor.persistedOutputPath(forged)).toBeNull();
  });

  it("persistedPreview 复用已有落盘，不重复写文件", () => {
    const compactor = makeCompactor(tmpDir);
    const output = "y".repeat(5000);
    const first = compactor.persistedPreview("c1", output);
    const second = compactor.persistedPreview("c1", first);
    const savedLine = second.split("\n")[1] ?? "";
    expect(first).toContain(savedLine);
    const files = readdirSync(compactor.toolResultsDir).filter((f) => f.endsWith(".txt"));
    expect(files).toHaveLength(1);
  });
});
