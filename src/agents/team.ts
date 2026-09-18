import * as path from "node:path";
import { createLogger } from "@blh/logger";
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

const log = createLogger("agents.team");

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

  /** 保存团队运行时要用的所有依赖（任务仓库、消息总线、锁、目录、模型 provider、配置、hooks）。 */
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
  /** 设置「lead 轮次」回调：当 lead 收件箱有消息时，由定时器触发这个回调。 */
  setTeamTurn(callback: () => Promise<void>): void {
    this.teamTurn = callback;
  }

  /** 启动团队：每隔 200ms 检查一次 lead 收件箱；已经启动就直接返回。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.leadTimer = setInterval(() => {
      void this.leadTick();
    }, 200);
    this.leadTimer.unref();
  }

  /** 停止团队：清掉定时器，并给所有活跃 teammate 发关闭请求。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.leadTimer !== undefined) clearInterval(this.leadTimer);
    this.leadTimer = undefined;
    for (const name of [...this.activeTeammates.keys()]) {
      this.requestShutdown(name);
    }
  }

  /** 定时器每次触发都执行：lead 有消息且能拿到锁，就触发一次 team 轮次。 */
  private async leadTick(): Promise<void> {
    if (!this.bus.peek("lead")) return;
    if (!this.agentLock.tryAcquire()) return;
    try {
      if (this.teamTurn !== null) await this.teamTurn();
    } catch (error) {
      log.warn("lead tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.agentLock.release();
    }
  }

  // ---- bus 委托（teammate 侧） ----
  /** 读某个 agent 的收件箱，直接转发给 MessageBus。 */
  readInbox(name: string): BusMessage[] {
    return this.bus.readInbox(name);
  }

  /** 等某个 agent 的消息，直接转发给 MessageBus。 */
  waitForMessages(name: string, timeoutMs?: number): Promise<BusMessage[]> {
    return this.bus.waitForMessages(name, timeoutMs);
  }

  // ---- assignment / 任务 ----
  /** 返回某个队友当前任务的工作目录，并检查任务是否还属于它、目录有没有变。 */
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

  /** 找出某个队友正在进行中的任务，找不到就返回 null。 */
  private ownerInProgress(owner: string): Task | null {
    for (const task of this.store.list()) {
      if (task.status === "in_progress" && task.owner === owner) return task;
    }
    return null;
  }

  /** 算出一个任务对应的工作目录。 */
  private taskCwd(task: Task): string {
    return taskCwdOp(task, this.workdir, this.worktreesDir);
  }

  /** 让某个 owner 认领一个任务；认领成功后记下它负责的任务和工作目录，把版本号加一，最后返回认领结果文本。 */
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

  /** 让某个队友完成一个任务，出错时把错误信息当文本返回。 */
  completeTask(owner: string, taskId: string): string {
    try {
      return this.store.complete(taskId, owner);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 列出所有任务。 */
  listTasks(): Task[] {
    return this.store.list();
  }

  /** 找出还没人认领、且当前可以开始的任务（跳过目录算不出来的）。 */
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

  /** 让某个队友认领下一个可认领的任务；成功就返回这个任务，没有可认领的就返回 null。 */
  claimNextTask(name: string): Task | null {
    if (this.assignments.has(name) || this.ownerInProgress(name) !== null) return null;
    for (const task of this.scanUnclaimed()) {
      const result = this.claimTask(name, task.id);
      if (result.startsWith("Claimed ")) return this.store.load(task.id);
    }
    return null;
  }

  /** 把某个 owner 的版本号加一（表示它的工作变了）；如果它本来要交计划，就把它打回"重新交计划"，并清掉旧的计划请求。 */
  private bumpVersion(owner: string): void {
    this.assignmentVersions.set(owner, (this.assignmentVersions.get(owner) ?? 0) + 1);
    const gate = this.planGates.get(owner);
    if (gate !== undefined && gate !== "not_required") {
      this.planGates.set(owner, "required");
    }
    this.planRequestIds.delete(owner);
  }

  /** 返回某个队友当前的版本号和任务 id，用来判断计划有没有过期。 */
  private currentWorkIdentity(owner: string): [number, string | null] {
    const assignment = this.assignments.get(owner);
    return [this.assignmentVersions.get(owner) ?? 0, assignment ? assignment.taskId : null];
  }

  /** 任务做完后：清掉它负责的任务记录，把版本号加一，并把它标成"不用再交计划"。 */
  releaseCompleted(owner: string): void {
    const assignment = this.assignments.get(owner);
    if (!assignment) return;
    const task = this.store.load(assignment.taskId);
    if (task.status !== "completed" || task.owner !== owner) return;
    this.assignments.delete(owner);
    this.bumpVersion(owner);
    this.planGates.set(owner, "not_required");
  }

  /** 收尾一个 teammate：把它的任务重置回 pending，清掉它相关的所有状态。 */
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
  /** teammate 给 lead 或别的活跃 teammate 发一条消息。 */
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

  /** teammate 提交计划等 lead 审批：登记请求、置为 pending，并把计划发给 lead。 */
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

  /** 查某个队友的计划状态，默认返回"不用交计划"。 */
  getPlanGate(name: string): string {
    return this.planGates.get(name) ?? "not_required";
  }

  /** 设置某个队友的活跃状态。 */
  setActive(name: string, status: string): void {
    this.activeTeammates.set(name, status);
  }

  /** 处理关闭请求：校验通过就标记为 stopping，返回 [是否生效, requestId 或忽略原因]。 */
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

  /** 处理 lead 对计划的审批结果：校验通过就更新 plan gate 和状态，返回 [是否生效, 结果文本]。 */
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
  /** 生成一个不重复的请求 id（req_ 开头 + 6 位随机数）。 */
  private newRequestId(): string {
    for (;;) {
      const requestId = `req_${Math.floor(Math.random() * 1000000)
        .toString()
        .padStart(6, "0")}`;
      if (!this.pendingRequests.has(requestId)) return requestId;
    }
  }

  /** 创建并启动一个 teammate，做名字校验和认领（可选），返回结果文本。 */
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

  /** 列出所有活跃 teammate，按名字排序，格式为「名字: 状态」每行一个。 */
  listTeammates(): string {
    if (this.activeTeammates.size === 0) return "No active teammates.";
    return [...this.activeTeammates.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => `${name}: ${status}`)
      .join("\n");
  }

  /** lead 给某个活跃 teammate 发一条消息。 */
  leadSendMessage(to: string, content: string): string {
    if (!this.activeTeammates.has(to)) return `Teammate '${to}' is not active`;
    this.bus.send("lead", to, content);
    return `Sent to ${to}`;
  }

  /** lead 请求某个队友关闭：登记请求并发送关闭消息。 */
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

  /** lead 要求某个队友先提交计划：把它的计划状态设为"要交计划"并通知它。 */
  requestPlan(teammate: string, task: string): string {
    if (!this.activeTeammates.has(teammate)) {
      return `Teammate '${teammate}' is not active`;
    }
    this.planGates.set(teammate, "required");
    this.bus.send("lead", teammate, task, "plan_request");
    return `Plan requested from ${teammate}`;
  }

  /** lead 审批（同意/拒绝）一个计划，通过后把结果发回给对应 teammate。 */
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

  /** 为某个任务创建并绑定一个工作树。 */
  createWorktree(name: string, taskId: string): string {
    return createWorktreeOp(this.store, this.workdir, this.worktreesDir, name, taskId);
  }

  // ---- lead 收件箱消费 ----
  /** 读 lead 收件箱：先匹配响应更新请求状态，再把团队事件格式化成一条 user 消息塞进主对话。 */
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

  /** 把一条响应消息和待处理请求对上号，对上就更新请求状态为 approved/rejected。 */
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

  /** 把团队消息格式化成给主智能体看的文本（[类型] 发送者: 内容 一行一条）。 */
  private formatTeamEvents(msgs: BusMessage[]): string {
    const lines = msgs.map((msg) => {
      const requestId = msg.metadata["request_id"];
      const suffix = typeof requestId === "string" && requestId ? ` request_id=${requestId}` : "";
      return `[${msg.type}${suffix}] ${msg.from}: ${msg.content}`;
    });
    return "[Team events]\n" + lines.join("\n");
  }
}
