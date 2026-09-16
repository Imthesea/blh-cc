// src/memory/system.ts
import type { ChatMessage, ChatProvider } from "../core/types.js";
import { MemoryExtractor } from "./extract.js";
import { MemoryRecall } from "./recall.js";
import { MemoryStore } from "./store.js";

export class Memory {
  readonly recall: MemoryRecall;
  readonly extractor: MemoryExtractor;

  constructor(
    readonly store: MemoryStore,
    readonly provider: ChatProvider,
  ) {
    this.recall = new MemoryRecall(store, provider);
    this.extractor = new MemoryExtractor(store, provider);
  }

  async systemSection(messages: ChatMessage[]): Promise<string> {
    const relevant = await this.recall.loadMemories(messages);
    return this.recall.buildSystem(relevant);
  }

  async extract(messages: ChatMessage[]): Promise<number> {
    return this.extractor.extractMemories(messages);
  }

  async consolidate(): Promise<number> {
    return this.extractor.consolidateMemories();
  }
}
