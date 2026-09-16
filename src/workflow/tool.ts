/** Workflow 工具:校验、预留 runId、上锁、执行、落盘。 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { WorkflowJournal } from "./journal.js";
import { Budget, ExecutionState, type WorkflowFn, type WorkflowMeta, type WorkflowRegistry, type WorkflowRunner } from "./runtime.js";
import { WorkflowInputError } from "./schema.js";

const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;

export function createRunId(meta: WorkflowMeta): string {
  return `wf_${meta.name}_${randomBytes(8).toString("hex")}`;
}

export function createTaskId(runId: string): string {
  return `local_workflow_${runId}`;
}

export function validateMeta(meta: unknown): WorkflowMeta {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new WorkflowInputError("meta must be an object literal");
  }
  const m = meta as Record<string, unknown>;
  if (!m.name || !m.description) {
    throw new WorkflowInputError("meta requires `name` and `description`");
  }
  if (typeof m.name !== "string" || !WORKFLOW_NAME_RE.test(m.name)) {
    throw new WorkflowInputError(
      "meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'",
    );
  }
  if (typeof m.description !== "string") {
    throw new WorkflowInputError("meta.description must be a string");
  }
  return { name: m.name, description: m.description, ...(typeof m.phases === "object" && Array.isArray(m.phases) ? { phases: m.phases as string[] } : {}) };
}

export function validateRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new WorkflowInputError("invalid workflow runId");
  }
  return runId;
}

export class WorkflowTask {
  status = "running";
  usage: { agents: number; tokens: number } = { agents: 0, tokens: 0 };
  progress: Array<Record<string, unknown>> = [];

  constructor(
    readonly taskId: string,
    readonly runId: string,
    readonly meta: WorkflowMeta,
  ) {}

  progressEvent(ptype: string, data: Record<string, unknown>): void {
    this.progress.push({ type: ptype, ...data });
  }
}

export function serializeTask(task: WorkflowTask): Record<string, unknown> {
  return {
    taskId: task.taskId,
    taskType: "local_workflow",
    runId: task.runId,
    workflowName: task.meta.name,
    status: task.status,
    usage: { ...task.usage },
    progress: [...task.progress],
  };
}

const activeRuns = new Set<string>();

async function withWorkflowRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  if (activeRuns.has(runId)) {
    throw new WorkflowInputError(`workflow run ${runId} is already active`);
  }
  activeRuns.add(runId);
  try {
    return await fn();
  } finally {
    activeRuns.delete(runId);
  }
}

export class WorkflowTool {
  constructor(
    readonly store: string,
    readonly runnerFactory: () => WorkflowRunner,
    readonly workflows: WorkflowRegistry,
  ) {}

  async call(
    meta: WorkflowMeta,
    scriptFn: WorkflowFn,
    args?: Record<string, unknown>,
    resumeFromRunId?: string,
  ): Promise<{ launched: Record<string, unknown>; result: unknown; task: WorkflowTask }> {
    validateMeta(meta);
    const resuming = resumeFromRunId !== undefined;
    const runId = resuming ? validateRunId(resumeFromRunId) : this.reserveRunId(meta);
    return withWorkflowRunLock(runId, () => this.callLocked(meta, scriptFn, args, runId, resuming));
  }

  private async callLocked(
    meta: WorkflowMeta,
    scriptFn: WorkflowFn,
    args: Record<string, unknown> | undefined,
    runId: string,
    resuming: boolean,
  ): Promise<{ launched: Record<string, unknown>; result: unknown; task: WorkflowTask }> {
    let resolvedArgs: Record<string, unknown>;
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = this.readSnapshot(runId);
      if (snapshot.workflowName !== meta.name) {
        throw new WorkflowInputError("resume runId does not match workflow meta");
      }
      const savedArgs = (snapshot.args ?? {}) as Record<string, unknown>;
      if (args === undefined) {
        resolvedArgs = savedArgs;
      } else if (JSON.stringify(args) !== JSON.stringify(savedArgs)) {
        throw new WorkflowInputError("resume args do not match the original run");
      } else {
        resolvedArgs = args;
      }
      journal = new WorkflowJournal(runId, true, this.store);
    } else {
      resolvedArgs = args ?? {};
      journal = new WorkflowJournal(runId, false, this.store);
    }

    const task = new WorkflowTask(createTaskId(runId), runId, meta);
    const launched: Record<string, unknown> = {
      status: "async_launched",
      taskId: task.taskId,
      taskType: "local_workflow",
      runId,
      workflowName: meta.name,
    };
    this.writeJson(path.join(this.store, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args: resolvedArgs,
      task: serializeTask(task),
    });

    let result: unknown;
    try {
      const ctx = new ExecutionState(
        task,
        journal,
        this.runnerFactory(),
        new Budget(typeof resolvedArgs.budget === "number" ? resolvedArgs.budget : undefined),
        resolvedArgs,
        0,
        undefined,
        this.workflows,
      );
      result = await scriptFn(ctx, resolvedArgs);
      task.status = "completed";
    } catch (error) {
      task.status = "failed";
      result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      journal.close();
    }

    this.writeJson(path.join(this.store, `${runId}.output.json`), result);
    this.writeJson(path.join(this.store, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args: resolvedArgs,
      task: serializeTask(task),
    });
    this.saveLastRun(runId);
    return { launched, result, task };
  }

  private reserveRunId(meta: WorkflowMeta): string {
    mkdirSync(this.store, { recursive: true });
    for (let i = 0; i < 32; i++) {
      const runId = validateRunId(createRunId(meta));
      const snapshotPath = path.join(this.store, `${runId}.json`);
      try {
        const fd = openSync(snapshotPath, "wx", 0o600);
        closeSync(fd);
        return runId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new WorkflowInputError("could not allocate a unique workflow runId");
  }

  private readSnapshot(runId: string): Record<string, unknown> {
    const p = path.join(this.store, `${runId}.json`);
    if (!existsSync(p)) throw new WorkflowInputError(`resume snapshot not found for ${runId}`);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
    }
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
    }
    return snapshot as Record<string, unknown>;
  }

  private writeJson(p: string, value: unknown): void {
    mkdirSync(path.dirname(p), { recursive: true });
    const temporary = p + ".tmp";
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, p);
  }

  private saveLastRun(runId: string): void {
    writeFileSync(path.join(this.store, "last_run.txt"), runId, "utf8");
  }
}

export async function runWorkflow(
  name: string,
  args: Record<string, unknown> | undefined,
  resumeFromRunId: string | undefined,
  store: string,
  runnerFactory: () => WorkflowRunner,
  workflows: WorkflowRegistry,
): Promise<{ launched: Record<string, unknown>; result: unknown; task: Record<string, unknown> }> {
  if (typeof name !== "string") throw new WorkflowInputError("workflow name must be a string");
  if (!workflows.has(name)) throw new WorkflowInputError(`unknown workflow '${name}'`);
  if (args !== undefined && (typeof args !== "object" || Array.isArray(args))) {
    throw new WorkflowInputError("workflow args must be an object");
  }
  const entry = workflows.get(name);
  if (entry === undefined) throw new WorkflowInputError(`unknown workflow '${name}'`);
  const [meta, scriptFn] = entry;
  const out = await new WorkflowTool(store, runnerFactory, workflows).call(
    meta,
    scriptFn,
    args,
    resumeFromRunId,
  );
  return { launched: out.launched, result: out.result, task: serializeTask(out.task) };
}
