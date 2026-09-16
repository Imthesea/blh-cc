import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INDEX_NAME, MEMORY_TYPES, MemoryStore } from "../../src/memory/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "memory-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(): MemoryStore {
  return new MemoryStore(path.join(tmpDir, ".memory"));
}

describe("MemoryStore primitives", () => {
  it("parseFrontmatter roundtrip", () => {
    const text = "---\nname: user-preference-tabs\ndescription: User prefers tabs\ntype: user\n---\n\nBody here.\n";
    const [meta, body] = MemoryStore.parseFrontmatter(text);
    expect(meta).toEqual({
      name: "user-preference-tabs",
      description: "User prefers tabs",
      type: "user",
    });
    expect(body).toBe("Body here.\n");
  });

  it("parseFrontmatter missing returns empty", () => {
    const [meta, body] = MemoryStore.parseFrontmatter("just body\n");
    expect(meta).toEqual({});
    expect(body).toBe("just body\n");
  });

  it("parseFrontmatter invalid yaml returns original", () => {
    const text = "---\nname: [unclosed\n---\nbody\n";
    const [meta, body] = MemoryStore.parseFrontmatter(text);
    expect(meta).toEqual({});
    expect(body).toBe(text);
  });

  it("memorySlug normalizes", () => {
    expect(MemoryStore.memorySlug("User Preference: Tabs!")).toBe("user-preference-tabs");
    expect(MemoryStore.memorySlug("   ")).toBe("memory");
  });

  it("memoryPath rejects escape", () => {
    const store = makeStore();
    expect(() => store.memoryPath("../evil.md")).toThrow("Invalid memory filename: ../evil.md");
    expect(() => store.memoryPath("sub/evil.md")).toThrow("Invalid memory filename: sub/evil.md");
  });

  it("memoryPath rejects index as record", () => {
    const store = makeStore();
    expect(() => store.memoryPath("MEMORY.md")).toThrow("The memory index is not a memory record");
    expect(path.basename(store.memoryPath("MEMORY.md", true))).toBe(INDEX_NAME);
  });

  it("memory types constant", () => {
    expect([...MEMORY_TYPES]).toEqual(["user", "feedback", "project", "reference"]);
  });
});
