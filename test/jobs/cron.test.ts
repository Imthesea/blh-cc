import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cronMatches, CronScheduler, validateCron } from "../../src/jobs/cron.js";

describe("cronMatches", () => {
  it("matches every minute", () => {
    const moment = new Date(2026, 8, 14, 10, 30); // 2026-09-14 10:30 本地
    expect(cronMatches("* * * * *", moment)).toBe(true);
    expect(cronMatches("*/5 * * * *", moment)).toBe(true);
    expect(cronMatches("*/7 * * * *", moment)).toBe(false);
  });

  it("matches specific minute and hour", () => {
    expect(cronMatches("30 10 * * *", new Date(2026, 8, 14, 10, 30))).toBe(true);
    expect(cronMatches("30 10 * * *", new Date(2026, 8, 14, 10, 31))).toBe(false);
  });

  it("matches ranges and lists", () => {
    expect(cronMatches("0-30 10 * * *", new Date(2026, 8, 14, 10, 15))).toBe(true);
    expect(cronMatches("0,15,30 10 * * *", new Date(2026, 8, 14, 10, 15))).toBe(true);
    expect(cronMatches("0,15,30 10 * * *", new Date(2026, 8, 14, 10, 20))).toBe(false);
  });

  it("matches weekday", () => {
    const monday = new Date(2026, 7, 10, 9, 0); // 2026-08-10 周一,cron 周一=1
    expect(cronMatches("0 9 * * 1", monday)).toBe(true);
    expect(cronMatches("0 9 * * 2", monday)).toBe(false);
  });
});

describe("validateCron", () => {
  it("accepts valid expressions", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1-5")).toBeNull();
  });

  it("rejects wrong field count", () => {
    expect(validateCron("0 9 * *")).toContain("Expected 5 fields");
    expect(validateCron("0 9 * * * *")).toContain("Expected 5 fields");
  });

  it("rejects out of range values", () => {
    expect(validateCron("60 9 * * *")).not.toBeNull();
    expect(validateCron("0 24 * * *")).toContain("hour");
    expect(validateCron("0 9 0 * *")).not.toBeNull();
    expect(validateCron("0 9 * 13 *")).not.toBeNull();
  });

  it("rejects malformed fields", () => {
    expect(validateCron("x 9 * * *")).not.toBeNull();
    expect(validateCron("*/0 * * * *")).not.toBeNull();
    expect(validateCron("5-1 * * * *")).not.toBeNull();
  });
});

let tmpDir: string;
let durablePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
  durablePath = path.join(tmpDir, ".scheduled_tasks.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const makeScheduler = () => new CronScheduler(durablePath);

describe("CronScheduler", () => {
  it("schedule returns job", () => {
    const job = makeScheduler().schedule("0 9 * * *", "run tests");
    expect(job.id.startsWith("cron_")).toBe(true);
    expect(job.prompt).toBe("run tests");
    expect(job.recurring).toBe(true);
    expect(job.durable).toBe(true);
  });

  it("schedule rejects invalid cron", () => {
    expect(() => makeScheduler().schedule("bad cron", "x")).toThrowError();
  });

  it("schedule rejects empty prompt", () => {
    expect(() => makeScheduler().schedule("0 9 * * *", "  ")).toThrowError(
      "Prompt cannot be empty",
    );
  });

  it("durable schedule persists and loads", () => {
    const job = makeScheduler().schedule("0 9 * * *", "run tests");
    expect(existsSync(durablePath)).toBe(true);
    const reloaded = new CronScheduler(durablePath);
    reloaded.load();
    expect(reloaded.listJobs().map((j) => j.id)).toEqual([job.id]);
  });

  it("non-durable schedule not persisted", () => {
    makeScheduler().schedule("0 9 * * *", "run tests", true, false);
    expect(existsSync(durablePath)).toBe(false);
  });

  it("cancel existing and missing", () => {
    const sched = makeScheduler();
    const job = sched.schedule("0 9 * * *", "x");
    expect(sched.cancel(job.id)).toBe(`Cancelled ${job.id}`);
    expect(sched.cancel(job.id)).toBe(`Job ${job.id} not found`);
  });

  it("pollDue enqueues once per minute", () => {
    const sched = makeScheduler();
    sched.schedule("* * * * *", "ping");
    const moment = new Date(2026, 8, 14, 10, 30);
    sched.pollDue(moment);
    expect(sched.hasQueue()).toBe(true);
    sched.pollDue(moment); // last_fired 防同一分钟重复入队
    expect(sched.consumeQueue()).toHaveLength(1);
  });

  it("consume and acknowledge one-shot", () => {
    const sched = makeScheduler();
    const job = sched.schedule("* * * * *", "ping", false);
    sched.pollDue(new Date(2026, 8, 14, 10, 30));
    const fired = sched.consumeQueue();
    expect(fired.map((j) => j.id)).toEqual([job.id]);
    sched.acknowledge(fired);
    expect(sched.listJobs()).toEqual([]);
  });

  it("restore puts jobs back", () => {
    const sched = makeScheduler();
    const job = sched.schedule("* * * * *", "ping");
    sched.pollDue(new Date(2026, 8, 14, 10, 30));
    const fired = sched.consumeQueue();
    sched.restore(fired);
    expect(sched.hasQueue()).toBe(true);
    expect(sched.consumeQueue().map((j) => j.id)).toEqual([job.id]);
  });

  it("load corrupt file reports error", () => {
    writeFileSync(durablePath, "{broken");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sched = makeScheduler();
    sched.load();
    expect(logSpy.mock.calls.flat().join(" ")).toContain("could not load");
    expect(sched.listJobs()).toEqual([]);
  });
});
