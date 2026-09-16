import * as path from "node:path";
import type { ChatMessage, ChatProvider, Config } from "../core/types.js";
import type { HookBus } from "../core/hooks.js";
import type { AgentLock } from "../jobs/runtime.js";
import type { Task, TaskStore } from "../planning/tasks.js";
import { isValidAgentName, MessageBus } from "./bus.js";
import type { BusMessage } from "./bus.js";
import { TeammateRuntime } from "./teammate.js";
import type { TeammateTeam } from "./teammate.js";
import { createWorktree as createWorktreeOp, taskCwd as taskCwdOp } from "./worktree.js";

const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

interface ProtocolState {
  requestId: string;
  type: string;
  sender: string;
  target: string;
  status: string;
  payload: string;
  workVersion: number | null;
  taskId: string | null;
  createdAt: number;
}

interface Assignment {
  taskId: string;
  cwd: string;
}

/** TeamRuntime：组合 MessageBus / TeammateRuntime / 协议 / assignment / plan gate。 */
export class TeamRuntime implements TeammateTeam {
  readonly activeTeammates = new Map<string, string>();
  readonly planGates = new Map<string, string>();
  readonly planRequestIds = new Map<string, string>();
  readonly pendingRequests = new Map<string, ProtocolState>();
  readonly assignments = new Map<string, Assignment>();
  readonly assignmentVersions = new Map<string, number>();
  started = false;

  private teamTurn: (() => Promise<void>) | null = null;
  private leadTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly store: TaskStore,
    readonly bus: MessageBus,
    readonly agentLock: AgentLock,
    readonly workdir: string,
    readonly worktreesDir: string,
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
  ) {}

  // ---- 生命周期 ----
  setTeamTurn(callback: () => Promise<void>): void {
    this.teamTurn = callback;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.leadTimer = setInterval(() => {
      void this.leadTick();
    }, 200);
    this.leadTimer.unref();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.leadTimer !== undefined) clearInterval(this.leadTimer);
    this.leadTimer = undefined;
    for (const name of [...this.activeTeammates.keys()]) {
      this.requestShutdown(name);
    }
  }

  private async leadTick(): Promise<void> {
    if (!this.bus.peek("lead")) return;
    if (!this.agentLock.tryAcquire()) return;
    try {
      if (this.teamTurn !== null) await this.teamTurn();
    } finally {
      this.agentLock.release();
    }
  }

  // ---- bus 委托（teammate 侧） ----
  readInbox(name: string): BusMessage[] {
    return this.bus.readInbox(name);
  }

  waitForMessages(name: string, timeoutMs?: number): Promise<BusMessage[]> {
    return this.bus.waitForMessages(name, timeoutMs);
  }

  // ---- assignment / 任务 ----
  assignmentCwd(owner: string): string {
    let assignment = this.assignments.get(owner);
    const inProgress = this.ownerInProgress(owner);
    if (inProgress && (!assignment || assignment.taskId !== inProgress.id)) {
      const cwd = this.taskCwd(inProgress);
      assignment = { taskId: inProgress.id, cwd };
      this.assignments.set(owner, assignment);
    } else if (!assignment) {
      throw new Error("Claim a Task before using workspace tools.");
    }
    const current = assignment;
    const task = this.store.load(current.taskId);
    if ((task.status !== "in_progress" && task.status !== "completed") || task.owner !== owner) {
      throw new Error(`Assignment for ${owner} is no longer active`);
    }
    const cwd = this.taskCwd(task);
    if (path.resolve(cwd) !== path.resolve(current.cwd)) {
      throw new Error(`Assignment cwd changed for task ${task.id}`);
    }
    return cwd;
  }

  private ownerInProgress(owner: string): Task | null {
    for (const task of this.store.list()) {
      if (task.status === "in_progress" && task.owner === owner) return task;
    }
    return null;
  }

  private taskCwd(task: Task): string {
    return taskCwdOp(task, this.workdir, this.worktreesDir);
  }

  claimTask(owner: string, taskId: string): string {
    if (this.assignments.has(owner) || this.ownerInProgress(owner) !== null) {
      return "Owner must complete its current task first";
    }
    let result: string;
    try {
      result = this.store.claim(taskId, owner);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (result.startsWith("Claimed ")) {
      const task = this.store.load(taskId);
      const cwd = this.taskCwd(task);
      this.assignments.set(owner, { taskId: task.id, cwd });
      this.bumpVersion(owner);
    }
    return result;
  }

  completeTask(owner: string, taskId: string): string {
    try {
      return this.store.complete(taskId, owner);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  listTasks(): Task[] {
    return this.store.list();
  }

  private scanUnclaimed(): Task[] {
    const ready: Task[] = [];
    for (const task of this.store.list()) {
      if (task.status !== "pending" || task.owner !== null) continue;
      if (!this.store.canStart(task.id)) continue;
      try {
        this.taskCwd(task);
      } catch {
        continue;
      }
      ready.push(task);
    }
    return ready;
  }

  claimNextTask(name: string): Task | null {
    if (this.assignments.has(name) || this.ownerInProgress(name) !== null) return null;
    for (const task of this.scanUnclaimed()) {
      const result = this.claimTask(name, task.id);
      if (result.startsWith("Claimed ")) return this.store.load(task.id);
    }
    return null;
  }

  private bumpVersion(owner: string): void {
    this.assignmentVersions.set(owner, (this.assignmentVersions.get(owner) ?? 0) + 1);
    const gate = this.planGates.get(owner);
    if (gate !== undefined && gate !== "not_required") {
      this.planGates.set(owner, "required");
    }
    this.planRequestIds.delete(owner);
  }

  private currentWorkIdentity(owner: string): [number, string | null] {
    const assignment = this.assignments.get(owner);
    return [this.assignmentVersions.get(owner) ?? 0, assignment ? assignment.taskId : null];
  }

  releaseCompleted(owner: string): void {
    const assignment = this.assignments.get(owner);
    if (!assignment) return;
    const task = this.store.load(assignment.taskId);
    if (task.status !== "completed" || task.owner !== owner) return;
    this.assignments.delete(owner);
    this.bumpVersion(owner);
    this.planGates.set(owner, "not_required");
  }

  finishTeammate(owner: string): void {
    const task = this.ownerInProgress(owner);
    if (task) {
      task.status = "pending";
      task.owner = null;
      this.store.save(task);
    }
    this.assignments.delete(owner);
    this.bumpVersion(owner);
    this.planGates.delete(owner);
    this.planRequestIds.delete(owner);
    this.activeTeammates.delete(owner);
  }

  // ---- 协议（teammate 侧） ----
  sendMessage(
    fromName: string,
    to: string,
    content: string,
    msgType = "message",
    metadata: Record<string, unknown> = {},
  ): string {
    if (to !== "lead" && !this.activeTeammates.has(to)) {
      return `Agent '${to}' is not active`;
    }
    this.bus.send(fromName, to, content, msgType, metadata);
    return `Sent to ${to}`;
  }

  submitPlan(fromName: string, plan: string): string {
    const assignment = this.assignments.get(fromName);
    const taskId = assignment ? assignment.taskId : null;
    const workVersion = this.assignmentVersions.get(fromName) ?? 0;
    if (this.planGates.get(fromName) === "pending") {
      return "A plan is already waiting for review.";
    }
    const requestId = this.newRequestId();
    this.pendingRequests.set(requestId, {
      requestId,
      type: "plan_approval",
      sender: fromName,
      target: "lead",
      status: "pending",
      payload: plan,
      workVersion,
      taskId,
      createdAt: Date.now() / 1000,
    });
    this.planGates.set(fromName, "pending");
    this.planRequestIds.set(fromName, requestId);
    this.activeTeammates.set(fromName, "waiting_approval");
    this.bus.send(fromName, "lead", plan, "plan_approval_request", { request_id: requestId });
    return `Plan submitted (${requestId}). Wait for Lead's decision.`;
  }

  getPlanGate(name: string): string {
    return this.planGates.get(name) ?? "not_required";
  }

  setActive(name: string, status: string): void {
    this.activeTeammates.set(name, status);
  }

  applyShutdownRequest(name: string, msg: BusMessage): [boolean, string] {
    const requestId = String(msg.metadata["request_id"] ?? "");
    const state = this.pendingRequests.get(requestId);
    const valid =
      msg.from === "lead" &&
      msg.to === name &&
      state !== undefined &&
      state.type === "shutdown" &&
      state.sender === "lead" &&
      state.target === name &&
      state.status === "pending" &&
      this.activeTeammates.get(name) !== "stopping";
    if (!valid) return [false, "[Ignored shutdown request: request mismatch]"];
    this.activeTeammates.set(name, "stopping");
    return [true, requestId];
  }

  applyPlanResponse(name: string, msg: BusMessage): [boolean, string] {
    const requestId = String(msg.metadata["request_id"] ?? "");
    const [workVersion, taskId] = this.currentWorkIdentity(name);
    const state = this.pendingRequests.get(requestId);
    const expectedId = this.planRequestIds.get(name);
    const valid =
      msg.from === "lead" &&
      msg.to === name &&
      requestId === expectedId &&
      state !== undefined &&
      state.type === "plan_approval" &&
      state.sender === name &&
      state.target === "lead" &&
      state.workVersion === workVersion &&
      state.taskId === taskId &&
      (state.status === "approved" || state.status === "rejected") &&
      Boolean(msg.metadata["approve"]) === (state.status === "approved");
    if (!valid) return [false, "[Ignored plan response: request mismatch]"];
    this.planGates.set(name, state.status);
    this.activeTeammates.set(name, "working");
    this.planRequestIds.delete(name);
    const outcome = state.status;
    return [true, `[Plan ${outcome}] ${msg.content}`];
  }

  // ---- 协议（lead 侧） ----
  private newRequestId(): string {
    for (;;) {
      const requestId = `req_${Math.floor(Math.random() * 1000000)
        .toString()
        .padStart(6, "0")}`;
      if (!this.pendingRequests.has(requestId)) return requestId;
    }
  }

  spawnTeammate(name: string, role: string, prompt: string, taskId?: string, requirePlan = false): string {
    if (!isValidAgentName(name)) {
      return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
    }
    if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
      return `Invalid teammate name: '${name}' is reserved by the runtime`;
    }
    if ([...this.activeTeammates.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      return `Teammate '${name}' already exists`;
    }
    this.activeTeammates.set(name, "working");
    this.planGates.set(name, requirePlan ? "required" : "not_required");
    this.assignmentVersions.set(name, 0);
    if (taskId !== undefined) {
      const claimed = this.claimTask(name, taskId);
      if (!claimed.startsWith("Claimed ")) {
        this.activeTeammates.delete(name);
        this.planGates.delete(name);
        this.assignmentVersions.delete(name);
        return `Cannot spawn teammate '${name}': ${claimed}`;
      }
    }
    const runtime = new TeammateRuntime(
      name,
      role,
      prompt,
      taskId ?? null,
      requirePlan,
      this.provider,
      this.config,
      this.hooks,
      this.store,
      this,
    );
    void runtime.run();
    const assigned = taskId !== undefined ? ` for ${taskId}` : " without an initial Task";
    return `Teammate '${name}' spawned as ${role}${assigned}. End this turn; the runtime will deliver its events.`;
  }

  listTeammates(): string {
    if (this.activeTeammates.size === 0) return "No active teammates.";
    return [...this.activeTeammates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => `${name}: ${status}`)
      .join("\n");
  }

  leadSendMessage(to: string, content: string): string {
    if (!this.activeTeammates.has(to)) return `Teammate '${to}' is not active`;
    this.bus.send("lead", to, content);
    return `Sent to ${to}`;
  }

  requestShutdown(teammate: string): string {
    if (!this.activeTeammates.has(teammate)) {
      return `Teammate '${teammate}' is not active`;
    }
    const requestId = this.newRequestId();
    this.pendingRequests.set(requestId, {
      requestId,
      type: "shutdown",
      sender: "lead",
      target: teammate,
      status: "pending",
      payload: "",
      workVersion: null,
      taskId: null,
      createdAt: Date.now() / 1000,
    });
    this.bus.send("lead", teammate, "Finish the current step and shut down.", "shutdown_request", {
      request_id: requestId,
    });
    return `Shutdown requested from ${teammate} (${requestId})`;
  }

  requestPlan(teammate: string, task: string): string {
    if (!this.activeTeammates.has(teammate)) {
      return `Teammate '${teammate}' is not active`;
    }
    this.planGates.set(teammate, "required");
    this.bus.send("lead", teammate, task, "plan_request");
    return `Plan requested from ${teammate}`;
  }

  reviewPlan(requestId: string, approve: boolean, feedback = ""): string {
    const state = this.pendingRequests.get(requestId);
    if (!state) return `Request ${requestId} not found`;
    if (state.type !== "plan_approval") return `Request ${requestId} is not a plan`;
    if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
    const [workVersion, taskId] = this.currentWorkIdentity(state.sender);
    if (state.workVersion !== workVersion || state.taskId !== taskId) {
      return `Request ${requestId} belongs to an earlier assignment`;
    }
    if (this.planRequestIds.get(state.sender) !== requestId) {
      return `Request ${requestId} is not the current plan`;
    }
    state.status = approve ? "approved" : "rejected";
    const sender = state.sender;
    const content = feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
    this.bus.send("lead", sender, content, "plan_approval_response", {
      request_id: requestId,
      approve,
    });
    return `Plan ${state.status} (${requestId})`;
  }

  createWorktree(name: string, taskId: string): string {
    return createWorktreeOp(this.store, this.workdir, this.worktreesDir, name, taskId);
  }

  // ---- lead 收件箱消费 ----
  consumeAndInjectTeam(messages: ChatMessage[]): number {
    const msgs = this.bus.readInbox("lead");
    for (const msg of msgs) {
      const requestId = msg.metadata["request_id"];
      if (typeof requestId === "string" && requestId && msg.type.endsWith("_response")) {
        this.matchResponse(msg.type, requestId, Boolean(msg.metadata["approve"]), msg.from, msg.to);
      }
    }
    if (msgs.length === 0) return 0;
    messages.push({ role: "user", content: this.formatTeamEvents(msgs) });
    return msgs.length;
  }

  private matchResponse(
    responseType: string,
    requestId: string,
    approve: boolean,
    fromAgent: string,
    toAgent: string,
  ): void {
    const state = this.pendingRequests.get(requestId);
    if (!state) return;
    const expected = state.type === "shutdown" ? "shutdown_response" : "plan_approval_response";
    if (responseType !== expected) return;
    if (fromAgent !== state.target || toAgent !== state.sender) return;
    if (state.status !== "pending") return;
    state.status = approve ? "approved" : "rejected";
  }

  private formatTeamEvents(msgs: BusMessage[]): string {
    const lines = msgs.map((msg) => {
      const requestId = msg.metadata["request_id"];
      const suffix = typeof requestId === "string" && requestId ? ` request_id=${requestId}` : "";
      return `[${msg.type}${suffix}] ${msg.from}: ${msg.content}`;
    });
    return "[Team events]\n" + lines.join("\n");
  }
}
