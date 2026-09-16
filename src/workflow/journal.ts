/** WorkflowJournal:append-only jsonl,resume 时按稳定 key 回放缓存。 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MISS, WorkflowInputError, stableHash, stableStringify } from "./schema.js";

export class WorkflowJournal {
  private readonly cache = new Map<string, unknown>();
  private readonly path: string;

  constructor(readonly runId: string, resume: boolean, readonly store: string) {
    mkdirSync(store, { recursive: true });
    this.path = path.join(store, `${runId}.journal.jsonl`);
    if (resume) {
      if (!existsSync(this.path)) {
        throw new WorkflowInputError(`resume journal not found for ${runId}`);
      }
      const lines = readFileSync(this.path, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line === "") continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          throw new WorkflowInputError(`invalid resume journal record at line ${i + 1}`);
        }
        if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
          throw new WorkflowInputError(`invalid resume journal record at line ${i + 1}`);
        }
        const r = rec as Record<string, unknown>;
        if (typeof r.key !== "string" || !("value" in r)) {
          throw new WorkflowInputError(`invalid resume journal record at line ${i + 1}`);
        }
        this.cache.set(r.key, r.value);
      }
    } else {
      writeFileSync(this.path, "");
    }
  }

  key(kind: string, label: string, prompt: string, schema: unknown): string {
    const basis = `${kind}|${label}|${prompt}|${schema === undefined ? "null" : stableStringify(schema)}`;
    const n = Number(stableHash(basis) % 10n ** 10n);
    return `${kind}-${String(n).padStart(10, "0")}`;
  }

  cached(key: string): unknown | typeof MISS {
    return this.cache.has(key) ? this.cache.get(key) : MISS;
  }

  record(key: string, value: unknown): void {
    appendFileSync(this.path, JSON.stringify({ key, value }) + "\n");
    this.cache.set(key, value);
  }

  close(): void {
    // 同步 IO,无文件句柄需要关闭
  }
}
