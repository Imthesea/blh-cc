import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  removeWorktree,
  taskCwd,
  validateWorktreeName,
  worktreeBranch,
  worktreePath,
} from "../../src/agents/worktree.js";
import { TaskStore } from "../../src/planning/tasks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "worktree-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.stdout}`);
  }
}

function initRepo(dir: string): void {
  git(dir, "init");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Tester");
  writeFileSync(path.join(dir, "f.txt"), "x");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
}

describe("worktree", () => {
  it("validateWorktreeName", () => {
    expect(validateWorktreeName("fix-1")).toBeNull();
    expect(validateWorktreeName("a/b")).not.toBeNull();
    expect(validateWorktreeName("..")).not.toBeNull();
    expect(validateWorktreeName("-x")).not.toBeNull();
  });

  it("worktreeBranch prefixes wt/", () => {
    expect(worktreeBranch("fix-1")).toBe("wt/fix-1");
  });

  it("worktreePath rejects escape", () => {
    expect(() => worktreePath(tmpDir, "../etc")).toThrow();
  });

  it("creates and removes a worktree", () => {
    initRepo(tmpDir);
    const store = new TaskStore(path.join(tmpDir, ".tasks"));
    const task = store.create("ship feature");
    const worktreesDir = path.join(tmpDir, ".worktrees");
    const result = createWorktree(store, tmpDir, worktreesDir, "feat-1", task.id);
    expect(result).toContain("created");
    const bound = store.load(task.id);
    expect(bound.worktree).toBe("feat-1");
    expect(existsSync(path.join(worktreesDir, "feat-1"))).toBe(true);
    // git 在 Windows 上报长路径，Node 的 tmpdir 可能是 8.3 短路径，故只校验目录名与存在性
    const cwd = taskCwd(bound, tmpDir, worktreesDir);
    expect(path.basename(cwd)).toBe("feat-1");
    expect(existsSync(cwd)).toBe(true);

    store.claim(task.id);
    store.complete(task.id);
    const removed = removeWorktree(store, tmpDir, worktreesDir, "feat-1");
    expect(removed).toContain("removed");
    expect(store.load(task.id).worktree).toBeNull();
  });
});
