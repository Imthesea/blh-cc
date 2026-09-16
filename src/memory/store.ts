import path from "node:path";
import { parse as parseYaml } from "yaml";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const TEMPORARY_MEMORY_MARKERS = [
  "this session", "current session", "this turn", "current turn",
  "this task", "current task", "for now", "just this time", "today only",
  "本次会话", "当前会话", "这一轮", "当前轮次", "本次任务", "当前任务",
  "暂时", "今回だけ", "このセッション", "現在のタスク",
] as const;

export const INDEX_NAME = "MEMORY.md";

export class MemoryStore {
  readonly directory: string;
  readonly indexPath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.indexPath = path.join(this.directory, INDEX_NAME);
  }

  static parseFrontmatter(text: string): [Record<string, unknown>, string] {
    if (!text.startsWith("---\n")) {
      return [{}, text];
    }
    const parts = text.split("---");
    if (parts.length < 3) {
      return [{}, text];
    }
    let metadata: unknown;
    try {
      metadata = parseYaml(parts[1] ?? "") || {};
    } catch {
      return [{}, text];
    }
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
      return [{}, text];
    }
    return [metadata as Record<string, unknown>, parts.slice(2).join("---").trimStart()];
  }

  static memorySlug(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
    return slug || "memory";
  }

  memoryPath(filename: string, allowIndex = false): string {
    if (path.basename(filename) !== filename) {
      throw new Error(`Invalid memory filename: ${filename}`);
    }
    if (filename === INDEX_NAME && !allowIndex) {
      throw new Error("The memory index is not a memory record");
    }
    const candidate = path.resolve(this.directory, filename);
    const relative = path.relative(path.resolve(this.directory), candidate);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Memory path escapes the store: ${filename}`);
    }
    return candidate;
  }
}
