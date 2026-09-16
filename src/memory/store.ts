import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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

  private static normalized(value: string): string {
    return value.toLowerCase().split(/\s+/).filter((part) => part !== "").join(" ");
  }

  shouldStoreMemory(candidate: Record<string, unknown>, existing: Record<string, unknown>[]): boolean {
    if (candidate.scope !== "persistent") {
      return false;
    }
    if (typeof candidate.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(candidate.type)) {
      return false;
    }

    const name = String(candidate.name ?? "").trim();
    const description = String(candidate.description ?? "").trim();
    const body = String(candidate.body ?? "").trim();
    if (!name || !description || !body) {
      return false;
    }

    const candidateText = MemoryStore.normalized(`${name}\n${description}\n${body}`);
    if (TEMPORARY_MEMORY_MARKERS.some((marker) => candidateText.includes(marker))) {
      return false;
    }

    const slug = MemoryStore.memorySlug(name);
    const normalizedDescription = MemoryStore.normalized(description);
    const normalizedBody = MemoryStore.normalized(body);
    for (const memory of existing) {
      if (MemoryStore.memorySlug(String(memory.name ?? "")) === slug) {
        return false;
      }
      if (MemoryStore.normalized(String(memory.description ?? "")) === normalizedDescription) {
        return false;
      }
      if (MemoryStore.normalized(String(memory.body ?? "")) === normalizedBody) {
        return false;
      }
    }
    return true;
  }

  memoryDocument(name: string, memType: string, description: string, body: string): string {
    const metadata = stringifyYaml(
      { name, description, type: memType },
      { sortMapEntries: false },
    ).trim();
    return `---\n${metadata}\n---\n\n${body.trim()}\n`;
  }

  writeMemoryFile(name: string, memType: string, description: string, body: string): string {
    if (!name.trim()) {
      throw new Error("Memory name cannot be empty");
    }
    if (!(MEMORY_TYPES as readonly string[]).includes(memType)) {
      throw new Error(`Unknown memory type: ${memType}`);
    }
    if (!description.trim() || !body.trim()) {
      throw new Error("Memory description and body cannot be empty");
    }
    mkdirSync(this.directory, { recursive: true });
    const filePath = this.memoryPath(`${MemoryStore.memorySlug(name)}.md`);
    writeFileSync(filePath, this.memoryDocument(name, memType, description, body), "utf-8");
    this.rebuildMemoryIndex();
    return filePath;
  }

  rebuildMemoryIndex(): void {
    mkdirSync(this.directory, { recursive: true });
    const lines: string[] = [];
    for (const fileName of readdirSync(this.directory).filter((f) => f.endsWith(".md")).sort()) {
      if (fileName === INDEX_NAME) {
        continue;
      }
      let filePath: string;
      try {
        filePath = this.memoryPath(fileName);
      } catch {
        continue;
      }
      const [metadata, body] = MemoryStore.parseFrontmatter(readFileSync(filePath, "utf-8"));
      const name = String(metadata.name || path.basename(fileName, ".md"))
        .split(/\s+/).filter((part) => part !== "").join(" ");
      const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
      const description = String(metadata.description || firstLine)
        .split(/\s+/).filter((part) => part !== "").join(" ");
      lines.push(`- [${name}](${fileName}) - ${description}`);
    }
    writeFileSync(
      this.memoryPath(INDEX_NAME, true),
      lines.join("\n") + (lines.length ? "\n" : ""),
      "utf-8",
    );
  }

  readMemoryIndex(): string {
    let filePath: string;
    try {
      filePath = this.memoryPath(INDEX_NAME, true);
    } catch {
      return "";
    }
    return existsSync(filePath) ? readFileSync(filePath, "utf-8").trim() : "";
  }

  readMemoryFile(filename: string): string | null {
    let filePath: string;
    try {
      filePath = this.memoryPath(filename);
    } catch {
      return null;
    }
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  listMemoryFiles(): MemoryRecord[] {
    const records: MemoryRecord[] = [];
    if (!existsSync(this.directory)) {
      return records;
    }
    for (const fileName of readdirSync(this.directory).filter((f) => f.endsWith(".md")).sort()) {
      if (fileName === INDEX_NAME) {
        continue;
      }
      let filePath: string;
      try {
        filePath = this.memoryPath(fileName);
      } catch {
        continue;
      }
      const [metadata, body] = MemoryStore.parseFrontmatter(readFileSync(filePath, "utf-8"));
      records.push({
        filename: fileName,
        name: String(metadata.name || path.basename(fileName, ".md")),
        description: String(metadata.description || ""),
        type: String(metadata.type || "project"),
        body: body.trim(),
      });
    }
    return records;
  }
}

export type MemoryRecord = {
  filename: string;
  name: string;
  description: string;
  type: string;
  body: string;
};
