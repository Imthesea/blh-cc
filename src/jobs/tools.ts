import type { ToolRegistry } from "../tools/registry.js";
import type { CronJob, CronScheduler } from "./cron.js";

function scheduled(job: CronJob): string {
  return `Scheduled ${job.id}: ${job.cron} -> ${job.prompt}`;
}

function listed(jobs: CronJob[]): string {
  if (jobs.length === 0) return "No cron jobs.";
  return jobs
    .map((job) => {
      const frequency = job.recurring ? "recurring" : "one-shot";
      const storage = job.durable ? "durable" : "session";
      return `${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`;
    })
    .join("\n");
}

export function registerJobsTools(registry: ToolRegistry, scheduler: CronScheduler): void {
  registry.register({
    name: "schedule_cron",
    description: "Schedule a prompt with a 5-field cron expression.",
    parameters: {
      type: "object",
      properties: {
        cron: { type: "string" },
        prompt: { type: "string" },
        recurring: { type: "boolean" },
        durable: { type: "boolean" },
      },
      required: ["cron", "prompt"],
    },
    handler: async (args) =>
      scheduled(
        scheduler.schedule(
          String(args["cron"] ?? ""),
          String(args["prompt"] ?? ""),
          args["recurring"] !== false,
          args["durable"] !== false,
        ),
      ),
  });
  registry.register({
    name: "list_crons",
    description: "List scheduled cron jobs.",
    parameters: { type: "object", properties: {} },
    handler: async () => listed(scheduler.listJobs()),
  });
  registry.register({
    name: "cancel_cron",
    description: "Cancel a cron job by ID.",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
    handler: async (args) => scheduler.cancel(String(args["job_id"] ?? "")),
  });
}
