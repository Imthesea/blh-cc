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
}
