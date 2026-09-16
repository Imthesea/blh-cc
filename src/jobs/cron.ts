/** cron 表达式解析与校验(五段式,零依赖)。 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % Number(field.slice(2)) === 0;
  if (field.includes(",")) {
    return field.split(",").some((part) => cronFieldMatches(part.trim(), value));
  }
  if (field.includes("-")) {
    const dash = field.indexOf("-");
    return Number(field.slice(0, dash)) <= value && value <= Number(field.slice(dash + 1));
  }
  return value === Number(field);
}

export function cronMatches(cronExpr: string, moment: Date): boolean {
  const trimmed = cronExpr.trim();
  const fields = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const cronWeekday = moment.getDay(); // 周日=0…周六=6,与 cron 定义一致
  if (
    !(
      cronFieldMatches(minute, moment.getMinutes()) &&
      cronFieldMatches(hour, moment.getHours()) &&
      cronFieldMatches(month, moment.getMonth() + 1)
    )
  ) {
    return false;
  }
  const dayMatches = cronFieldMatches(day, moment.getDate());
  const weekdayMatches = cronFieldMatches(weekday, cronWeekday);
  if (day === "*" && weekday === "*") return true;
  if (day === "*") return weekdayMatches;
  if (weekday === "*") return dayMatches;
  return dayMatches || weekdayMatches;
}

function validateCronField(field: string, minimum: number, maximum: number): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || Number(step) <= 0) return `Invalid step: ${field}`;
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const error = validateCronField(part.trim(), minimum, maximum);
      if (error) return error;
    }
    return null;
  }
  if (field.includes("-")) {
    const dash = field.indexOf("-");
    const start = field.slice(0, dash);
    const end = field.slice(dash + 1);
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return `Invalid range: ${field}`;
    const startValue = Number(start);
    const endValue = Number(end);
    if (startValue > endValue) return `Range start is greater than end: ${field}`;
    if (startValue < minimum || endValue > maximum) {
      return `Range ${field} is outside [${minimum}-${maximum}]`;
    }
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = Number(field);
  if (value < minimum || value > maximum) return `Value ${value} is outside [${minimum}-${maximum}]`;
  return null;
}

export function validateCron(cronExpr: string): string | null {
  const trimmed = cronExpr.trim();
  const fields = trimmed === "" ? [] : trimmed.split(/\s+/);
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const fieldRules: Array<[string, number, number]> = [
    ["minute", 0, 59],
    ["hour", 0, 23],
    ["day-of-month", 1, 31],
    ["month", 1, 12],
    ["day-of-week", 0, 6],
  ];
  for (let i = 0; i < fields.length; i++) {
    const [name, minimum, maximum] = fieldRules[i] as [string, number, number];
    const error = validateCronField(fields[i] as string, minimum, maximum);
    if (error) return `${name}: ${error}`;
  }
  return null;
}

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  pending_delivery: boolean;
  last_fired: string | null;
}

function minuteMarker(moment: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ` +
    `${pad(moment.getHours())}:${pad(moment.getMinutes())}`
  );
}

function parseSavedJob(item: unknown): CronJob {
  if (typeof item !== "object" || item === null) throw new Error("job must be an object");
  const record = item as Record<string, unknown>;
  for (const field of ["id", "cron", "prompt"]) {
    if (typeof record[field] !== "string") throw new Error(`invalid field: ${field}`);
  }
  for (const field of ["recurring", "durable"]) {
    if (typeof record[field] !== "boolean") throw new Error(`invalid field: ${field}`);
  }
  const pending = record["pending_delivery"];
  const lastFired = record["last_fired"];
  if (pending !== undefined && typeof pending !== "boolean") {
    throw new Error("invalid field: pending_delivery");
  }
  if (lastFired !== undefined && lastFired !== null && typeof lastFired !== "string") {
    throw new Error("invalid field: last_fired");
  }
  return {
    id: record["id"] as string,
    cron: record["cron"] as string,
    prompt: record["prompt"] as string,
    recurring: record["recurring"] as boolean,
    durable: record["durable"] as boolean,
    pending_delivery: (pending as boolean | undefined) ?? false,
    last_fired: (lastFired as string | null | undefined) ?? null,
  };
}

export class CronScheduler {
  private readonly jobs: Record<string, CronJob> = {};
  private queue: CronJob[] = [];

  constructor(readonly durablePath: string) {}

  private newId(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const jobId = `cron_${randomBytes(4).toString("hex")}`;
      if (!(jobId in this.jobs)) return jobId;
    }
    throw new Error("Could not allocate a cron job ID");
  }

  private save(): void {
    const payload = Object.values(this.jobs).filter((job) => job.durable);
    const temporary = path.join(
      path.dirname(this.durablePath),
      `${path.basename(this.durablePath)}.${process.pid}.tmp`,
    );
    try {
      writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf-8");
      renameSync(temporary, this.durablePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  schedule(cron: string, prompt: string, recurring = true, durable = true): CronJob {
    const error = validateCron(cron);
    if (error) throw new Error(error);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) throw new Error("Prompt cannot be empty");
    const job: CronJob = {
      id: this.newId(),
      cron,
      prompt: trimmedPrompt,
      recurring,
      durable,
      pending_delivery: false,
      last_fired: null,
    };
    this.jobs[job.id] = job;
    try {
      if (durable) this.save();
    } catch (saveError) {
      delete this.jobs[job.id];
      throw saveError;
    }
    return job;
  }

  listJobs(): CronJob[] {
    return Object.values(this.jobs);
  }

  cancel(jobId: string): string {
    const job = this.jobs[jobId];
    if (job === undefined) return `Job ${jobId} not found`;
    const previousQueue = [...this.queue];
    delete this.jobs[jobId];
    this.queue = this.queue.filter((queued) => queued.id !== jobId);
    try {
      if (job.durable) this.save();
    } catch (saveError) {
      this.jobs[jobId] = job;
      this.queue = previousQueue;
      throw saveError;
    }
    return `Cancelled ${jobId}`;
  }

  private enqueueDue(job: CronJob, marker: string): void {
    const oldPending = job.pending_delivery;
    const oldLastFired = job.last_fired;
    job.pending_delivery = true;
    job.last_fired = marker;
    try {
      if (job.durable) this.save();
    } catch (saveError) {
      job.pending_delivery = oldPending;
      job.last_fired = oldLastFired;
      throw saveError;
    }
    this.queue.push(job);
  }

  pollDue(moment: Date): void {
    const marker = minuteMarker(moment);
    for (const job of Object.values(this.jobs)) {
      if (job.pending_delivery || job.last_fired === marker) continue;
      if (cronMatches(job.cron, moment)) this.enqueueDue(job, marker);
    }
  }

  consumeQueue(): CronJob[] {
    const jobs = [...this.queue];
    this.queue = [];
    return jobs;
  }

  acknowledge(delivered: CronJob[]): void {
    let durableChanged = false;
    for (const job of delivered) {
      const current = this.jobs[job.id];
      if (current === undefined) continue;
      if (current.recurring) {
        current.pending_delivery = false;
        durableChanged = durableChanged || current.durable;
      } else {
        durableChanged = durableChanged || current.durable;
        delete this.jobs[current.id];
      }
    }
    if (durableChanged) {
      try {
        this.save();
      } catch (saveError) {
        // 持久化失败仅记录,at-least-once 允许重复
        console.log(`  [cron] acknowledgement persistence failed: ${saveError}`);
      }
    }
  }

  restore(delivered: CronJob[]): void {
    const queuedIds = new Set(this.queue.map((job) => job.id));
    for (const job of delivered) {
      const current = this.jobs[job.id];
      if (current === undefined) continue;
      current.pending_delivery = true;
      if (!queuedIds.has(current.id)) {
        this.queue.push(current);
        queuedIds.add(current.id);
      }
    }
  }

  hasQueue(): boolean {
    return this.queue.length > 0;
  }

  load(): void {
    if (!existsSync(this.durablePath)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(this.durablePath, "utf-8"));
      if (!Array.isArray(payload)) throw new Error("expected a JSON list");
    } catch (loadError) {
      console.log(`  [cron] could not load ${path.basename(this.durablePath)}: ${loadError}`);
      return;
    }
    for (const item of payload) {
      try {
        const job = parseSavedJob(item);
        const error = validateCron(job.cron);
        if (error) throw new Error(error);
        if (!job.id.startsWith("cron_")) throw new Error("invalid job ID");
        if (!job.prompt.trim()) throw new Error("prompt cannot be empty");
        this.jobs[job.id] = job;
        if (job.pending_delivery) this.queue.push(job);
      } catch (itemError) {
        console.log(`  [cron] skipped invalid saved job: ${itemError}`);
      }
    }
  }
}
