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

describe("TaskStore dependencies and state machine", () => {
  it("updateDependencies adds edge", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    expect(store.updateDependencies(b.id, [a.id]).blocked_by).toEqual([a.id]);
  });

  it("updateDependencies rejects missing dep", () => {
    const store = makeStore();
    const b = store.create("b");
    expect(() => store.updateDependencies(b.id, ["task_deadbeef"])).toThrow("dependency does not exist");
  });

  it("updateDependencies rejects self", () => {
    const store = makeStore();
    const a = store.create("a");
    expect(() => store.updateDependencies(a.id, [a.id])).toThrow("task cannot depend on itself");
  });

  it("updateDependencies rejects cycle", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    store.updateDependencies(a.id, [b.id]);
    expect(() => store.updateDependencies(b.id, [a.id])).toThrow("circular dependency");
  });

  it("dependsOn transitive", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    const c = store.create("c");
    store.updateDependencies(b.id, [a.id]);
    store.updateDependencies(c.id, [b.id]);
    expect(store.dependsOn(c.id, a.id)).toBe(true);
    expect(store.dependsOn(a.id, c.id)).toBe(false);
  });

  it("dependsOn terminates on a pre-existing cycle", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    const c = store.create("c");
    a.blocked_by = [b.id];
    b.blocked_by = [a.id];
    store.save(a);
    store.save(b);
    expect(store.dependsOn(a.id, c.id)).toBe(false);
  });

  it("incompleteDependencies and canStart", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    store.updateDependencies(b.id, [a.id]);
    expect(store.incompleteDependencies(store.load(b.id))).toEqual([a.id]);
    expect(store.canStart(b.id)).toBe(false);
    expect(store.canStart(a.id)).toBe(true);
    store.claim(a.id);
    store.complete(a.id);
    expect(store.canStart(b.id)).toBe(true);
    expect(store.incompleteDependencies(store.load(b.id))).toEqual([]);
  });

  it("claim blocked and unblocked", () => {
    const store = makeStore();
    const a = store.create("a");
    const b = store.create("b");
    store.updateDependencies(b.id, [a.id]);
    expect(store.claim(b.id)).toContain("blocked by");
    expect(store.claim(a.id)).toBe(`Claimed ${a.id}.`);
  });

  it("claim idempotent and completed", () => {
    const store = makeStore();
    const a = store.create("a");
    store.claim(a.id);
    expect(store.claim(a.id)).toContain("already in progress");
    store.complete(a.id);
    expect(store.claim(a.id)).toContain("already completed");
  });

  it("complete requires claim", () => {
    const store = makeStore();
    const a = store.create("a");
    expect(store.complete(a.id)).toContain("claim it first");
  });

  it("complete owner mismatch", () => {
    const store = makeStore();
    const a = store.create("a");
    store.claim(a.id, "alice");
    expect(store.complete(a.id, "bob")).toContain("owned by alice");
    expect(store.complete(a.id, "alice")).toBe(`Completed ${a.id}.`);
  });
});
