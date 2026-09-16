import { POST_TOOL_USE, PRE_TOOL_USE } from "../core/hooks.js";
import type { HookBus } from "../core/hooks.js";
import type { ChatMessage, ChatProvider, Config, ToolCall } from "../core/types.js";
import { approvalContext } from "../security/approval.js";
import { runBash } from "../tools/bash.js";
import { editFile, readFile, writeFile } from "../tools/files.js";
import { glob } from "../tools/glob.js";
import { ToolRegistry } from "../tools/registry.js";
import type { BusMessage } from "./bus.js";
import type { Task, TaskStore } from "../planning/tasks.js";

const IDLE_SCAN_INTERVAL = 2000;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** TeammateRuntime 依赖的 TeamRuntime 能力（结构化类型，避免与 team.ts 的循环 import）。 */
export interface TeammateTeam {
  assignmentCwd(owner: string): string;
  claimTask(owner: string, taskId: string): string;
  completeTask(owner: string, taskId: string): string;
  listTasks(): Task[];
  sendMessage(
    fromName: string,
    to: string,
    content: string,
    msgType?: string,
    metadata?: Record<string, unknown>,
  ): string;
  submitPlan(fromName: string, plan: string): string;
  applyShutdownRequest(name: string, msg: BusMessage): [boolean, string];
  applyPlanResponse(name: string, msg: BusMessage): [boolean, string];
  getPlanGate(name: string): string;
  setActive(name: string, status: string): void;
  releaseCompleted(name: string): void;
  finishTeammate(name: string): void;
  claimNextTask(name: string): Task | null;
  readInbox(name: string): BusMessage[];
  waitForMessages(name: string, timeoutMs?: number): Promise<BusMessage[]>;
}

const ICONS: Record<string, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };

export class TeammateRuntime {
  readonly tools: ToolRegistry;
  readonly messages: ChatMessage[];
  private readonly system: string;

  constructor(
    readonly name: string,
    readonly role: string,
    prompt: string,
    readonly taskId: string | null,
    readonly requirePlan: boolean,
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
    readonly store: TaskStore,
    readonly team: TeammateTeam,
  ) {
    this.system =
      `You are '${name}', a ${role}. Use tools to complete the assigned Task, ` +
      "then call complete_task and report a concise result. " +
      "If the first user message contains [Assigned task], that Task is already claimed; " +
      "do not call claim_task for it again. " +
      "When asked for a plan, call submit_plan and wait for approval before bash or file changes. " +
      "File and shell tools use the Task's working directory; that directory is not a sandbox. " +
      "The runtime delivers your final text to Lead. Use send_message only for intermediate " +
      "coordination, and address the coordinator as 'lead'.";

    let userContent = prompt;
    if (taskId) {
      const task = store.load(taskId);
      const cwd = team.assignmentCwd(name);
      userContent += `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
    }
    if (requirePlan) {
      userContent +=
        "\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.";
    }
    this.messages = [
      { role: "system", content: this.system },
      { role: "user", content: userContent },
    ];
    this.tools = this.buildTools();
  }

  private buildTools(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "bash",
      description: "Run a shell command in the task's working directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      handler: async (args) => this.runBash(args),
    });
    registry.register({
      name: "read_file",
      description: "Read a file with line numbers in the task's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
      },
      handler: async (args) => this.runRead(args),
    });
    registry.register({
      name: "write_file",
      description: "Write content to a file in the task's working directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      handler: async (args) => this.runWrite(args),
    });
    registry.register({
      name: "edit_file",
      description: "Replace old_text with new_text in the task's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
      handler: async (args) => this.runEdit(args),
    });
    registry.register({
      name: "glob",
      description: "Find files matching a glob pattern in the task's working directory.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      handler: async (args) => this.runGlob(args),
    });
    registry.register({
      name: "send_message",
      description: "Send an intermediate message to 'lead' or an active teammate.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" } },
        required: ["to", "content"],
      },
      handler: async (args) =>
        this.team.sendMessage(this.name, String(args["to"] ?? ""), String(args["content"] ?? "")),
    });
    registry.register({
      name: "submit_plan",
      description: "Submit a work plan for Lead approval.",
      parameters: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] },
      handler: async (args) => this.team.submitPlan(this.name, String(args["plan"] ?? "")),
    });
    registry.register({
      name: "list_tasks",
      description: "List shared tasks.",
      parameters: { type: "object", properties: {} },
      handler: async () => this.renderTasks(),
    });
    registry.register({
      name: "claim_task",
      description: "Claim a ready task.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      handler: async (args) => this.team.claimTask(this.name, String(args["task_id"] ?? "")),
    });
    registry.register({
      name: "complete_task",
      description: "Complete an owned task.",
      parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      handler: async (args) => this.team.completeTask(this.name, String(args["task_id"] ?? "")),
    });
    return registry;
  }

  private currentCwd(): { cwd: string } | { error: string } {
    try {
      return { cwd: this.team.assignmentCwd(this.name) };
    } catch (error) {
      return {
        error: `Error: Invalid task assignment: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async runBash(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return runBash(current.cwd, this.config.bashTimeout, this.config.maxOutputChars, args);
  }

  private async runRead(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return readFile(current.cwd, args);
  }

  private async runWrite(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return writeFile(current.cwd, args);
  }

  private async runEdit(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return editFile(current.cwd, args);
  }

  private async runGlob(args: Record<string, unknown>): Promise<string> {
    const current = this.currentCwd();
    if ("error" in current) return current.error;
    return glob(current.cwd, args);
  }

  private renderTasks(): string {
    const tasks = this.team.listTasks();
    if (tasks.length === 0) return "No tasks.";
    return tasks
      .map((task) => {
        const deps = task.blocked_by.length > 0 ? ` (blocked_by: ${task.blocked_by.join(", ")})` : "";
        const owner = task.owner ? ` [${task.owner}]` : "";
        const wt = task.worktree ? ` (worktree: ${task.worktree})` : "";
        return `${ICONS[task.status] ?? "[?]"} ${task.id}: ${task.subject} [${task.status}]${owner}${deps}${wt}`;
      })
      .join("\n");
  }

  private async runTool(event: { name: string; input: Record<string, unknown> }): Promise<string> {
    const name = event.name;
    const gate = this.team.getPlanGate(this.name);
    if (
      (name === "bash" || name === "write_file" || name === "edit_file") &&
      gate !== "not_required" &&
      gate !== "approved"
    ) {
      return `Blocked: plan status is ${gate}.`;
    }
    const previous = approvalContext.scheduledTurn;
    approvalContext.scheduledTurn = true;
    try {
      const blocked = await this.hooks.firstBlock(PRE_TOOL_USE, { name, input: event.input });
      if (blocked !== null) return blocked;
      const result = await this.tools.dispatch(name, event.input);
      await this.hooks.trigger(POST_TOOL_USE, { name, input: event.input, output: result });
      return result;
    } finally {
      approvalContext.scheduledTurn = previous;
    }
  }

  handleInbox(inbox: BusMessage[]): boolean {
    const workMessages: string[] = [];
    for (const msg of inbox) {
      if (msg.type === "shutdown_request") {
        const [accepted, notice] = this.team.applyShutdownRequest(this.name, msg);
        if (!accepted) {
          workMessages.push(notice);
          continue;
        }
        this.team.sendMessage(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: notice,
          approve: true,
        });
        return true;
      }
      if (msg.type === "plan_approval_response") {
        const [, notice] = this.team.applyPlanResponse(this.name, msg);
        workMessages.push(notice);
        continue;
      }
      if (msg.type === "plan_request") {
        workMessages.push(`[Plan required] ${msg.content}`);
        continue;
      }
      workMessages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (workMessages.length > 0) {
      this.messages.push({ role: "user", content: workMessages.join("\n") });
    }
    return false;
  }

  async waitForWork(): Promise<boolean> {
    for (;;) {
      const inbox = await this.team.waitForMessages(this.name, IDLE_SCAN_INTERVAL);
      if (inbox.length > 0) {
        const before = this.messages.length;
        if (this.handleInbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }
      const task = this.team.claimNextTask(this.name);
      if (!task) continue;
      const cwd = this.team.assignmentCwd(this.name);
      this.messages.push({
        role: "user",
        content: `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`,
      });
      return true;
    }
  }

  async work(): Promise<string> {
    if (this.handleInbox(this.team.readInbox(this.name))) return "stop";
    this.team.setActive(this.name, "working");
    let assistant: ChatMessage;
    try {
      assistant = await this.provider.chat(this.messages, this.tools.list());
    } catch (error) {
      this.team.sendMessage(
        this.name,
        "lead",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        "error",
      );
      return "stop";
    }
    this.messages.push(assistant);
    const toolCalls: ToolCall[] = assistant.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const call of toolCalls) {
        const name = call.function.name;
        const input = parseArgs(call.function.arguments);
        const result = await this.runTool({ name, input });
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      return "continue";
    }
    const summary = assistant.content ?? "";
    const gate = this.team.getPlanGate(this.name);
    if (gate !== "pending" && summary) {
      this.team.sendMessage(this.name, "lead", summary, "result");
    }
    if (gate === "pending") {
      this.team.setActive(this.name, "waiting_approval");
    } else {
      this.team.releaseCompleted(this.name);
      this.team.setActive(this.name, "idle");
      this.team.sendMessage(this.name, "lead", "Waiting for more work.", "idle_notification");
    }
    return "idle";
  }

  async run(): Promise<void> {
    try {
      let state = "continue";
      while (state !== "stop") {
        if (state === "idle" && !(await this.waitForWork())) break;
        state = await this.work();
      }
    } catch (error) {
      try {
        this.team.sendMessage(
          this.name,
          "lead",
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          "error",
        );
      } catch {
        // 收尾阶段的发送失败可忽略
      }
    } finally {
      try {
        this.team.finishTeammate(this.name);
      } catch {
        // 收尾阶段的清理失败可忽略
      }
    }
  }
}
