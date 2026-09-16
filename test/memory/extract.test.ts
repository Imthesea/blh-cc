import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatProvider, ToolDefinition } from "../../src/core/types.js";
import { MemoryExtractor } from "../../src/memory/extract.js";
import { MemoryStore } from "../../src/memory/store.js";

class MockProvider implements ChatProvider {
  readonly requests: { messages: ChatMessage[]; tools: ToolDefinition[]; maxTokens: number | undefined }[] = [];
  private readonly scripted: ChatMessage[];

  constructor(scripted: ChatMessage[]) {
    this.scripted = [...scripted];
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage> {
    this.requests.push({ messages, tools, maxTokens });
    const next = this.scripted.shift();
    if (!next) {
      throw new Error("MockProvider exhausted");
    }
    return next;
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-extract-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExtractor(provider?: ChatProvider): MemoryExtractor {
  return new MemoryExtractor(new MemoryStore(path.join(tmpDir, ".memory")), provider ?? new MockProvider([]));
}

describe("MemoryExtractor", () => {
  it("dialogueText last messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const text = makeExtractor().dialogueText(messages);
    expect(text).toContain("user: hello");
    expect(text).toContain("assistant: hi there");
  });

  it("validateMemoryRecord", () => {
    const extractor = makeExtractor();
    const good = { name: "Pref", type: "user", description: "d", body: "b", scope: "persistent" };
    expect(extractor.validateMemoryRecord(good, true)?.name).toBe("Pref");
    expect(extractor.validateMemoryRecord({ ...good, scope: "current_task" }, true)).not.toBeNull();
    expect(extractor.validateMemoryRecord({ ...good, scope: "weird" }, true)).toBeNull();
    expect(extractor.validateMemoryRecord({ name: "", type: "user", description: "d", body: "b" })).toBeNull();
    expect(extractor.validateMemoryRecord("not a dict")).toBeNull();
  });

  it("extractMemories stores persistent", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const provider = new MockProvider([{
      role: "assistant",
      content: JSON.stringify([
        { name: "Pref", type: "user", scope: "persistent", description: "Likes tabs", body: "Use tabs." },
      ]),
    }]);
    const extractor = new MemoryExtractor(store, provider);
    const messages: ChatMessage[] = [
      { role: "user", content: "I prefer tabs" },
      { role: "assistant", content: "noted" },
    ];
    expect(await extractor.extractMemories(messages)).toBe(1);
    expect(store.readMemoryFile("pref.md")).not.toBeNull();
    expect(provider.requests[0]?.maxTokens).toBe(1000);
  });

  it("extractMemories skips current_task scope", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    const provider = new MockProvider([{
      role: "assistant",
      content: JSON.stringify([
        { name: "Temp", type: "user", scope: "current_task", description: "d", body: "b" },
      ]),
    }]);
    const extractor = new MemoryExtractor(store, provider);
    expect(await extractor.extractMemories([
      { role: "user", content: "x" },
      { role: "assistant", content: "y" },
    ])).toBe(0);
    expect(store.listMemoryFiles()).toEqual([]);
  });

  it("extractMemories swallows provider error", async () => {
    const store = new MemoryStore(path.join(tmpDir, ".memory"));
    class Boom implements ChatProvider {
      async chat(): Promise<ChatMessage> {
        throw new Error("api down");
      }
    }
    const extractor = new MemoryExtractor(store, new Boom());
    expect(await extractor.extractMemories([{ role: "user", content: "hi" }])).toBe(0);
  });
});
