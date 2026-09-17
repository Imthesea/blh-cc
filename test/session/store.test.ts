import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("create 在 .sessions/ 下新建 session_<timestamp>.jsonl", () => {
    const store = SessionStore.create(tmpDir);
    expect(store.path.startsWith(path.join(tmpDir, ".sessions", "session_"))).toBe(true);
    expect(store.path.endsWith(".jsonl")).toBe(true);
    expect(existsSync(store.path)).toBe(true);
  });

  it("append 逐行追加 JSONL", () => {
    const store = SessionStore.create(tmpDir);
    store.append({ role: "user", content: "hello" });
    store.append({ role: "assistant", content: "hi" });
    const lines = readFileSync(store.path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ role: "user", content: "hello" });
    expect(JSON.parse(lines[1]!)).toEqual({ role: "assistant", content: "hi" });
  });

  it("load 还原消息数组并跳过空行与非法行", () => {
    const store = SessionStore.create(tmpDir);
    appendFileSync(store.path, '{"role":"user","content":"a"}\n', "utf8");
    appendFileSync(store.path, "\n", "utf8");
    appendFileSync(store.path, "not-json\n", "utf8");
    appendFileSync(store.path, '{"role":"assistant","content":"b"}\n', "utf8");
    const messages = SessionStore.load(store.path);
    expect(messages).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("load 对不存在的文件返回空数组", () => {
    expect(SessionStore.load(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("latest 返回 mtime 最新的 .jsonl，目录为空/缺失时返回 null", () => {
    expect(SessionStore.latest(tmpDir)).toBeNull();
    const older = SessionStore.create(tmpDir);
    const newer = SessionStore.create(tmpDir);
    writeFileSync(newer.path, '{"role":"user","content":"touch"}\n', "utf8");
    expect(SessionStore.latest(tmpDir)).toBe(newer.path);
    expect(newer.path).not.toBe(older.path);
  });

  it("open 返回指向给定路径的实例", () => {
    const store = SessionStore.open(path.join(tmpDir, "custom.jsonl"));
    expect(store.path).toBe(path.join(tmpDir, "custom.jsonl"));
  });
});
