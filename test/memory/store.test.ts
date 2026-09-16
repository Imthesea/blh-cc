import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

describe("MemoryStore read/write", () => {
  it("memoryDocument has frontmatter and body", () => {
    const store = makeStore();
    const doc = store.memoryDocument("User Pref", "user", "Likes tabs", "Use tabs.");
    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toContain("name: User Pref");
    expect(doc).toContain("type: user");
    expect(doc.endsWith("Use tabs.\n")).toBe(true);
  });

  it("writeMemoryFile and index", () => {
    const store = makeStore();
    const filePath = store.writeMemoryFile("User Pref", "user", "Likes tabs", "Use tabs.");
    expect(path.basename(filePath)).toBe("user-pref.md");
    expect(existsSync(filePath)).toBe(true);
    expect(store.readMemoryIndex()).toContain("[User Pref](user-pref.md) - Likes tabs");
  });

  it("writeMemoryFile rejects invalid", () => {
    const store = makeStore();
    expect(() => store.writeMemoryFile("", "user", "d", "b")).toThrow("Memory name cannot be empty");
    expect(() => store.writeMemoryFile("n", "bad", "d", "b")).toThrow("Unknown memory type: bad");
    expect(() => store.writeMemoryFile("n", "user", "", "b")).toThrow("Memory description and body cannot be empty");
  });

  it("readMemoryFile", () => {
    const store = makeStore();
    store.writeMemoryFile("N", "user", "D", "B");
    expect(store.readMemoryFile("n.md")).not.toBeNull();
    expect(store.readMemoryFile("missing.md")).toBeNull();
  });

  it("listMemoryFiles skips index", () => {
    const store = makeStore();
    store.writeMemoryFile("A", "user", "desc a", "body a");
    store.writeMemoryFile("B", "project", "desc b", "body b");
    const records = store.listMemoryFiles();
    expect(records.map((r) => r.filename)).toEqual(["a.md", "b.md"]);
    expect(records[0]?.type).toBe("user");
  });

  it("shouldStoreMemory scope and temporary", () => {
    const store = makeStore();
    const good = { scope: "persistent", type: "user", name: "Pref", description: "Likes tabs", body: "Use tabs." };
    expect(store.shouldStoreMemory(good, [])).toBe(true);
    expect(store.shouldStoreMemory({ ...good, scope: "current_task" }, [])).toBe(false);
    expect(store.shouldStoreMemory({ ...good, type: "bad" }, [])).toBe(false);
    expect(store.shouldStoreMemory({ ...good, body: "" }, [])).toBe(false);
    expect(store.shouldStoreMemory({ ...good, body: "do this in this session" }, [])).toBe(false);
  });

  it("shouldStoreMemory dedup", () => {
    const store = makeStore();
    const existing = [{ name: "Pref", description: "Likes tabs", body: "Use tabs." }];
    const dupSlug = { scope: "persistent", type: "user", name: "pref", description: "other", body: "other body" };
    const dupDesc = { scope: "persistent", type: "user", name: "Other", description: "likes tabs", body: "x" };
    const dupBody = { scope: "persistent", type: "user", name: "Other", description: "y", body: "use tabs." };
    expect(store.shouldStoreMemory(dupSlug, existing)).toBe(false);
    expect(store.shouldStoreMemory(dupDesc, existing)).toBe(false);
    expect(store.shouldStoreMemory(dupBody, existing)).toBe(false);
  });
});
