import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { Task, TaskStore } from "../planning/tasks.js";

const VALID_WORKTREE_NAME = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateWorktreeName(name: string): string | null {
  if (typeof name !== "string" || !VALID_WORKTREE_NAME.test(name)) {
    return (
      "worktree name must be 1-64 letters, digits, dots, underscores, " +
      "or dashes, and start with a letter or digit"
    );
  }
  return null;
}

export function worktreeBranch(name: string): string {
  return `wt/${name}`;
}

export function worktreePath(worktreesDir: string, name: string): string {
  const resolved = path.resolve(worktreesDir, name);
  const root = path.resolve(worktreesDir);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Worktree path escapes directory: ${JSON.stringify(name)}`);
  }
  return resolved;
}

/** 等价 Python subprocess.run(capture_output=True, timeout=30)。 */
export function runGit(args: string[], cwd: string): [boolean, string] {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
  const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
  if (result.error) {
    return [false, `${result.error.name}: ${result.error.message}`];
  }
  return [result.status === 0, output.slice(0, 5000) || "(no output)"];
}

/** 以 branch 为键索引 git worktree 注册表：git 在 Windows 上报长路径，而 Node 的 workdir 可能是 8.3 短路径，按路径比较会误判。 */
function registeredWorktrees(workdir: string): [Record<string, Record<string, string>>, string | null] {
  const [ok, output] = runGit(["worktree", "list", "--porcelain"], workdir);
  if (!ok) return [{}, `cannot read Git worktree registry: ${output}`];
  const entries: Record<string, Record<string, string>> = {};
  let current: Record<string, string> = {};
  for (const line of [...output.split("\n"), ""]) {
    if (line === "") {
      const branch = current["branch"];
      if (branch) entries[branch] = current;
      current = {};
      continue;
    }
    const space = line.indexOf(" ");
    current[line.slice(0, space)] = line.slice(space + 1);
  }
  return [entries, null];
}

export function registeredWorktree(
  workdir: string,
  worktreesDir: string,
  name: string,
): [string | null, string | null] {
  try {
    worktreePath(worktreesDir, name);
  } catch (error) {
    return [null, error instanceof Error ? error.message : String(error)];
  }
  const [entries, error] = registeredWorktrees(workdir);
  if (error) return [null, error];
  const entry = entries[`refs/heads/${worktreeBranch(name)}`];
  if (entry === undefined) {
    return [null, `worktree '${name}' is not registered with Git`];
  }
  const rawPath = entry["worktree"];
  if (!rawPath) return [null, `worktree '${name}' is missing its path`];
  if (!existsSync(rawPath)) {
    return [null, `worktree '${name}' is missing at ${rawPath}`];
  }
  return [path.resolve(rawPath), null];
}

/** 解析任务工作目录；worktree 绑定损坏时 fail-closed。 */
export function taskCwd(task: Task, workdir: string, worktreesDir: string): string {
  if (!task.worktree) return path.resolve(workdir);
  const [resolved, error] = registeredWorktree(workdir, worktreesDir, task.worktree);
  if (error) throw new Error(error);
  return resolved as string;
}

export function createWorktree(
  store: TaskStore,
  workdir: string,
  worktreesDir: string,
  name: string,
  taskId: string,
): string {
  const nameError = validateWorktreeName(name);
  if (nameError) return `Error: ${nameError}`;
  let resolved: string;
  try {
    resolved = worktreePath(worktreesDir, name);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const branch = worktreeBranch(name);
  const wd = path.resolve(workdir);

  if (!store.exists(taskId)) return `Error: Task ${taskId} not found`;
  const task = store.load(taskId);
  if (task.status !== "pending" || task.owner !== null) {
    return `Error: Task ${taskId} must be pending and unowned`;
  }
  if (task.worktree) return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
  if (store.list().some((other) => other.id !== taskId && other.worktree === name)) {
    return `Error: Worktree '${name}' is already bound to another task`;
  }
  if (existsSync(resolved)) return `Error: Worktree path already exists: ${resolved}`;

  // runGit 把空输出归一为 "(no output)"；--show-cdup 在仓库根目录输出为空，子目录输出 "../"
  const [rootOk, cdup] = runGit(["rev-parse", "--show-cdup"], wd);
  if (!rootOk || cdup !== "(no output)") {
    return "Error: Working directory must be the root of a Git repository";
  }
  const [branchOk, branchCheck] = runGit(["check-ref-format", "--branch", branch], wd);
  if (!branchOk) return `Error: Invalid worktree branch '${branch}': ${branchCheck}`;
  const [branchExists] = runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], wd);
  if (branchExists) return `Error: Branch '${branch}' already exists`;
  const [entries, registryError] = registeredWorktrees(wd);
  if (registryError) return `Error: ${registryError}`;
  if (entries[`refs/heads/${branch}`] !== undefined) {
    return `Error: Worktree path is already registered: ${resolved}`;
  }

  mkdirSync(worktreesDir, { recursive: true });
  const [ok, result] = runGit(["worktree", "add", "-b", branch, resolved, "HEAD"], wd);
  if (!ok) {
    const [afterEntries, afterRegistryError] = registeredWorktrees(wd);
    const [afterBranchExists] = runGit(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      wd,
    );
    const artifacts: string[] = [];
    if (existsSync(resolved)) artifacts.push(`checkout path '${resolved}'`);
    if (afterRegistryError === null && afterEntries[`refs/heads/${branch}`] !== undefined) {
      artifacts.push("registered Git worktree");
    }
    if (afterBranchExists) artifacts.push(`branch '${branch}'`);
    if (artifacts.length > 0) {
      return (
        `Partial operation: git worktree add reported an error after leaving ${artifacts.join(", ")}. ` +
        `Task ${taskId} remains unbound and no Git data was deleted. Run \`git worktree list\`, ` +
        `inspect '${resolved}' and '${branch}', then keep or remove those artifacts manually after ` +
        `preserving any work. Git error: ${result}`
      );
    }
    return `Git error: ${result}`;
  }

  try {
    task.worktree = name;
    store.save(task);
  } catch (error) {
    return (
      `Partial success: Worktree '${name}' was created at ${resolved} on branch '${branch}', ` +
      `but task binding failed: ${error instanceof Error ? error.message : String(error)}. ` +
      "Git data was retained for manual recovery."
    );
  }

  return `Worktree '${name}' created at ${resolved} for task ${taskId}`;
}

export function removeWorktree(
  store: TaskStore,
  workdir: string,
  worktreesDir: string,
  name: string,
  discardChanges = false,
  leasedPaths?: string[],
): string {
  const nameError = validateWorktreeName(name);
  if (nameError) return `Error: ${nameError}`;
  const [registeredPath, pathError] = registeredWorktree(workdir, worktreesDir, name);
  if (pathError !== null || registeredPath === null) {
    return `Error: ${pathError ?? "unknown worktree error"}`;
  }
  const resolved = registeredPath;
  const bound = store.list().filter((task) => task.worktree === name);
  if (bound.length === 0) return `Error: Worktree '${name}' is not bound to a task`;
  const active = bound.filter((task) => task.status !== "completed");
  if (active.length > 0) {
    return `Error: Worktree '${name}' is bound to active task ${active[0]?.id}; complete it before removal`;
  }
  if (leasedPaths && leasedPaths.some((p) => path.resolve(p) === resolved)) {
    return `Error: Worktree '${name}' is still in use; wait for the turn to end`;
  }
  const [ok, status] = runGit(["status", "--porcelain", "--ignored"], resolved);
  if (!ok) return `Error: Cannot verify worktree '${name}' status: ${status}`;
  if (status !== "(no output)" && !discardChanges) {
    const changed = status.split("\n").filter((line) => line.trim() !== "").length;
    return `Error: Worktree '${name}' has ${changed} uncommitted change(s); preserve or discard them manually`;
  }
  const args = ["worktree", "remove"];
  if (discardChanges) args.push("--force");
  args.push(resolved);
  const [removeOk, result] = runGit(args, workdir);
  if (!removeOk) return `Git error: ${result}`;
  try {
    for (const task of bound) {
      task.worktree = null;
      store.save(task);
    }
  } catch (error) {
    return (
      `Partial success: Worktree '${name}' was removed and branch '${worktreeBranch(name)}' retained, ` +
      `but task unbinding failed: ${error instanceof Error ? error.message : String(error)}. ` +
      "Manual recovery is required."
    );
  }
  return `Worktree '${name}' removed; branch '${worktreeBranch(name)}' retained`;
}
