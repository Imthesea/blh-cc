import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../../src/planning/tasks.js";
import { TodoManager } from "../../src/planning/todo.js";
import { registerPlanningTools } from "../../src/planning/tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "planning-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerPlanningTools(registry, new TodoManager(), new TaskStore(path.join(tmpDir, ".tasks")));
  return registry;
}

describe("registerPlanningTools", () => {
  it("registers all planning tools", () => {
    const names = makeRegistry().list().map((t) => t.name);
    expect(new Set(names)).toEqual(
      new Set([
        "todo_write", "create_task", "update_task", "list_tasks",
        "get_task", "claim_task", "complete_task",
      ]),
    );
  });

  it("todo_write returns rendered list", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("todo_write", { todos: [{ content: "a", status: "pending" }] });
    expect(result).toBe("[ ] a");
  });

  it("create and list task roundtrip", async () => {
    const registry = makeRegistry();
    const created = await registry.dispatch("create_task", { subject: "ship it" });
    expect(created).toMatch(/^Created task_/);
    expect(await registry.dispatch("list_tasks", {})).toContain("ship it");
  });

  it("get_task returns json", async () => {
    const registry = makeRegistry();
    const created = await registry.dispatch("create_task", { subject: "x" });
    const taskId = created.split(":")[0]!.split(" ")[1]!;
    const data = JSON.parse(await registry.dispatch("get_task", { task_id: taskId })) as { id: string; subject: string };
    expect(data.id).toBe(taskId);
    expect(data.subject).toBe("x");
  });

  it("claim complete flow", async () => {
    const registry = makeRegistry();
    const created = await registry.dispatch("create_task", { subject: "x" });
    const taskId = created.split(":")[0]!.split(" ")[1]!;
    expect(await registry.dispatch("claim_task", { task_id: taskId })).toBe(`Claimed ${taskId}.`);
    expect(await registry.dispatch("complete_task", { task_id: taskId })).toBe(`Completed ${taskId}.`);
  });

  it("update_task adds dependency", async () => {
    const registry = makeRegistry();
    const a = await registry.dispatch("create_task", { subject: "a" });
    const b = await registry.dispatch("create_task", { subject: "b" });
    const idA = a.split(":")[0]!.split(" ")[1]!;
    const idB = b.split(":")[0]!.split(" ")[1]!;
    const result = await registry.dispatch("update_task", { task_id: idB, add_blocked_by: [idA] });
    expect(result).toContain(`blocked by ${idA}`);
  });
});
