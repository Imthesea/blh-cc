import type { ToolRegistry } from "../tools/registry.js";
import type { Task, TaskStore } from "./tasks.js";
import type { TodoManager } from "./todo.js";

const MARKS: Record<string, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

function created(task: Task): string {
  return `Created ${task.id}: ${task.subject}`;
}

function updated(task: Task): string {
  if (task.blocked_by.length > 0) {
    return `Updated ${task.id} (blocked by ${task.blocked_by.join(", ")}).`;
  }
  return `Updated ${task.id}.`;
}

function listed(tasks: Task[]): string {
  if (tasks.length === 0) return "No tasks.";
  return tasks
    .map((task) => {
      const suffix = task.blocked_by.length > 0 ? ` (blocked by: ${task.blocked_by.join(", ")})` : "";
      return `${MARKS[task.status] ?? "?"} ${task.id}: ${task.subject}${suffix}`;
    })
    .join("\n");
}

export function registerPlanningTools(
  registry: ToolRegistry,
  todoManager: TodoManager,
  taskStore: TaskStore,
): void {
  registry.register({
    name: "todo_write",
    description: "Create or replace the todo list to plan and track progress.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
    },
    handler: async (args) => todoManager.update(args["todos"]),
  });

  registry.register({
    name: "create_task",
    description: "Create a durable task, recoverable across sessions.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string" },
        description: { type: "string" },
      },
      required: ["subject"],
    },
    handler: async (args) =>
      created(taskStore.create(String(args["subject"] ?? ""), String(args["description"] ?? ""))),
  });

  registry.register({
    name: "update_task",
    description: "Add dependency edges to an existing task by ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        add_blocked_by: { type: "array", items: { type: "string" } },
      },
      required: ["task_id", "add_blocked_by"],
    },
    handler: async (args) =>
      updated(taskStore.updateDependencies(String(args["task_id"]), args["add_blocked_by"] as string[])),
  });

  registry.register({
    name: "list_tasks",
    description: "List all tasks, one line each.",
    parameters: { type: "object", properties: {} },
    handler: async () => listed(taskStore.list()),
  });

  registry.register({
    name: "get_task",
    description: "Show the full JSON of one task by ID.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
    handler: async (args) => JSON.stringify(taskStore.load(String(args["task_id"])), null, 2),
  });

  registry.register({
    name: "claim_task",
    description: "Claim an unblocked pending task (pending -> in_progress).",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
    handler: async (args) => taskStore.claim(String(args["task_id"])),
  });

  registry.register({
    name: "complete_task",
    description: "Complete an in_progress task (in_progress -> completed).",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
    handler: async (args) => taskStore.complete(String(args["task_id"])),
  });
}
