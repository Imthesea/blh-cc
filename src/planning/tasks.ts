import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: string;
  owner: string | null;
  blocked_by: string[];
}

const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;
const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

export class TaskStore {
  constructor(readonly directory: string) {}

  /** 暴露给测试以直接校验 ID 合法性（对齐蓝本 `_path`） */
  pathFor(taskId: string): string {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`invalid task ID: ${JSON.stringify(taskId)}`);
    }
    return path.join(this.directory, `${taskId}.json`);
  }

  exists(taskId: string): boolean {
    return existsSync(this.pathFor(taskId));
  }

  create(subject: string, description = ""): Task {
    const trimmed = subject.trim();
    if (!trimmed) throw new Error("task subject cannot be empty");
    mkdirSync(this.directory, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const task: Task = {
        id: `task_${randomBytes(4).toString("hex")}`,
        subject: trimmed,
        description,
        status: "pending",
        owner: null,
        blocked_by: [],
      };
      try {
        writeFileSync(this.pathFor(task.id), JSON.stringify(task, null, 2), {
          encoding: "utf8",
          flag: "wx",
        });
        return task;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("could not allocate a unique task ID");
  }

  load(taskId: string): Task {
    const data = JSON.parse(readFileSync(this.pathFor(taskId), "utf8")) as Task;
    if (data.id !== taskId) {
      throw new Error(`task file ID ${JSON.stringify(data.id)} != requested ${JSON.stringify(taskId)}`);
    }
    if (!VALID_STATUSES.includes(data.status as (typeof VALID_STATUSES)[number])) {
      throw new Error(`invalid task status: ${JSON.stringify(data.status)}`);
    }
    return data;
  }

  save(task: Task): void {
    writeFileSync(this.pathFor(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  list(): Task[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.load(name.slice(0, -".json".length)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 暴露给测试以直调（对齐蓝本 `_depends_on`） */
  dependsOn(taskId: string, targetId: string): boolean {
    const current = this.load(taskId);
    if (current.blocked_by.includes(targetId)) return true;
    return current.blocked_by.some((dep) => this.dependsOn(dep, targetId));
  }

  updateDependencies(taskId: string, addBlockedBy: string[]): Task {
    if (!Array.isArray(addBlockedBy)) throw new Error("add_blocked_by must be a list of task IDs");
    const task = this.load(taskId);
    for (const dep of addBlockedBy) {
      if (!this.exists(dep)) throw new Error(`dependency does not exist: ${dep}`);
      if (dep === taskId) throw new Error("task cannot depend on itself");
      if (this.dependsOn(dep, taskId)) throw new Error(`circular dependency: ${taskId} <-> ${dep}`);
      if (!task.blocked_by.includes(dep)) task.blocked_by.push(dep);
    }
    this.save(task);
    return task;
  }

  incompleteDependencies(task: Task): string[] {
    return task.blocked_by.filter((dep) => this.load(dep).status !== "completed");
  }

  canStart(taskId: string): boolean {
    const task = this.load(taskId);
    return task.status === "pending" && this.incompleteDependencies(task).length === 0;
  }

  claim(taskId: string, owner = "agent"): string {
    const task = this.load(taskId);
    if (task.status === "completed") return `Task ${task.id} is already completed.`;
    if (task.status === "in_progress") {
      return `Task ${task.id} is already in progress${task.owner ? ` by ${task.owner}.` : "."}`;
    }
    const blocked = this.incompleteDependencies(task);
    if (blocked.length > 0) {
      return `Task ${task.id} is blocked by: ${blocked.join(", ")}`;
    }
    task.status = "in_progress";
    task.owner = owner;
    this.save(task);
    return `Claimed ${task.id}.`;
  }

  complete(taskId: string, owner = "agent"): string {
    const task = this.load(taskId);
    if (task.status === "completed") return `Task ${task.id} is already completed.`;
    if (task.status !== "in_progress") {
      return `Cannot complete pending task ${task.id}; claim it first.`;
    }
    if (task.owner && task.owner !== owner) {
      return `Task ${task.id} is owned by ${task.owner}, not ${owner}.`;
    }
    task.status = "completed";
    this.save(task);
    return `Completed ${task.id}.`;
  }
}
