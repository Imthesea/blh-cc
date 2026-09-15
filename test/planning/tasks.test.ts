import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../../src/planning/tasks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "planning-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore(): TaskStore {
  return new TaskStore(path.join(tmpDir, ".tasks"));
}

describe("TaskStore", () => {
  it("create returns task and persists", () => {
    const store = makeStore();
    const task = store.create("ship it");
    expect(task.id).toMatch(/^task_[0-9a-f]{8}$/);
    expect(task.subject).toBe("ship it");
    expect(task.status).toBe("pending");
    expect(existsSync(path.join(tmpDir, ".tasks", `${task.id}.json`))).toBe(true);
  });

  it("create rejects empty subject", () => {
    expect(() => makeStore().create("   ")).toThrow("task subject cannot be empty");
  });

  it("load roundtrip", () => {
    const store = makeStore();
    const task = store.create("a", "desc");
    expect(store.load(task.id)).toEqual(task);
  });

  it("load missing raises", () => {
    expect(() => makeStore().load("task_deadbeef")).toThrow();
  });

  it("path rejects invalid ids", () => {
    const store = makeStore();
    for (const bad of ["../etc", "task_XYZ", "task_123", ""]) {
      expect(() => store.pathFor(bad)).toThrow("invalid task ID");
    }
  });

  it("list empty and sorted", () => {
    const store = makeStore();
    expect(store.list()).toEqual([]);
    const b = store.create("b");
    const a = store.create("a");
    const ids = store.list().map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    expect(ids).toEqual([...ids].sort());
  });
});
