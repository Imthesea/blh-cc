import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-files-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("safePath", () => {
  it("resolves relative paths inside workdir", async () => {
    const { safePath } = await import("../../src/tools/files.js");
    expect(safePath(dir, "a/b.txt")).toBe(path.join(dir, "a", "b.txt"));
  });

  it("throws PathEscapeError on escape", async () => {
    const { safePath, PathEscapeError } = await import("../../src/tools/files.js");
    expect(() => safePath(dir, "../evil.txt")).toThrow(PathEscapeError);
    expect(() => safePath(dir, "../evil.txt")).toThrow("path escapes workdir:");
  });
});

describe("readFile", () => {
  it("returns numbered lines", async () => {
    const { readFile } = await import("../../src/tools/files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "alpha\nbeta\ngamma\n");
    await expect(readFile(dir, { path: "f.txt" })).resolves.toBe("1\talpha\n2\tbeta\n3\tgamma");
  });

  it("honors start and limit", async () => {
    const { readFile } = await import("../../src/tools/files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "a\nb\nc\nd\n");
    await expect(readFile(dir, { path: "f.txt", start: 1, limit: 2 })).resolves.toBe("2\tb\n3\tc");
  });

  it("returns (no more lines) past EOF", async () => {
    const { readFile } = await import("../../src/tools/files.js");
    await fs.writeFile(path.join(dir, "f.txt"), "only\n");
    await expect(readFile(dir, { path: "f.txt", start: 5 })).resolves.toBe("(no more lines)");
  });
});

describe("writeFile", () => {
  it("writes file and returns char count", async () => {
    const { writeFile } = await import("../../src/tools/files.js");
    await expect(writeFile(dir, { path: "sub/out.txt", content: "hello" })).resolves.toBe(
      `wrote 5 chars to ${path.join(dir, "sub", "out.txt")}`,
    );
    await expect(fs.readFile(path.join(dir, "sub", "out.txt"), "utf8")).resolves.toBe("hello");
  });
});

describe("editFile", () => {
  it("replaces a unique occurrence", async () => {
    const { editFile } = await import("../../src/tools/files.js");
    await fs.writeFile(path.join(dir, "e.txt"), "foo bar foo");
    await expect(
      editFile(dir, { path: "e.txt", old_text: "foo", new_text: "baz" }),
    ).resolves.toBe("error: old_text occurs 2 times (must be exactly 1)");
    await expect(
      editFile(dir, { path: "e.txt", old_text: "bar", new_text: "baz" }),
    ).resolves.toBe(`edited ${path.join(dir, "e.txt")}`);
    await expect(fs.readFile(path.join(dir, "e.txt"), "utf8")).resolves.toBe("foo baz foo");
  });

  it("reports zero occurrences", async () => {
    const { editFile } = await import("../../src/tools/files.js");
    await fs.writeFile(path.join(dir, "e.txt"), "hello");
    await expect(
      editFile(dir, { path: "e.txt", old_text: "zzz", new_text: "q" }),
    ).resolves.toBe("error: old_text occurs 0 times (must be exactly 1)");
  });
});
