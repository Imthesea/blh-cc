import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronScheduler } from "../../src/jobs/cron.js";
import { registerJobsTools } from "../../src/jobs/tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "jobs-tools-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const makeRegistry = () => {
  const registry = new ToolRegistry();
  registerJobsTools(registry, new CronScheduler(path.join(tmpDir, ".scheduled_tasks.json")));
  return registry;
};

describe("registerJobsTools", () => {
  it("registers cron tools", () => {
    const names = makeRegistry().list().map((tool) => tool.name);
    expect(new Set(names)).toEqual(new Set(["schedule_cron", "list_crons", "cancel_cron"]));
  });

  it("schedule_cron returns scheduled", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("schedule_cron", {
      cron: "0 9 * * *",
      prompt: "run tests",
    });
    expect(result.startsWith("Scheduled cron_")).toBe(true);
    expect(result).toContain("run tests");
  });

  it("list_crons roundtrip", async () => {
    const registry = makeRegistry();
    await registry.dispatch("schedule_cron", { cron: "0 9 * * *", prompt: "run tests" });
    expect(await registry.dispatch("list_crons", {})).toContain("run tests");
  });

  it("cancel_cron", async () => {
    const registry = makeRegistry();
    const scheduledResult = await registry.dispatch("schedule_cron", {
      cron: "0 9 * * *",
      prompt: "x",
    });
    const jobId = scheduledResult.split(":")[0]!.split(" ")[1]!;
    expect(await registry.dispatch("cancel_cron", { job_id: jobId })).toBe(
      `Cancelled ${jobId}`,
    );
  });

  it("schedule_cron invalid expr", async () => {
    const registry = makeRegistry();
    const result = await registry.dispatch("schedule_cron", { cron: "bad", prompt: "x" });
    expect(result.startsWith("error: tool 'schedule_cron' failed")).toBe(true);
  });
});
