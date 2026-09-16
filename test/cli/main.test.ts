import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("buildHarness 装配", () => {
  let tmpDir: string;
  let savedKey: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cli-main-"));
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "k";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compactor 与 compact 工具就位", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.compactor?.transcriptDir).toBe(path.join(tmpDir, ".transcripts"));
    expect(harness.compactor?.toolResultsDir).toBe(
      path.join(tmpDir, ".task_outputs", "tool-results"),
    );
    expect(harness.tools.list().map((tool) => tool.name)).toContain("compact");
  });

  it("planning 工具与 todoManager 就位", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.todoManager).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of [
      "todo_write", "create_task", "update_task", "list_tasks",
      "get_task", "claim_task", "complete_task",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("memory 装配到 .memory 目录", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.memory).toBeDefined();
    expect(harness.memory?.store.directory).toBe(path.join(tmpDir, ".memory"));
  });

  it("jobs 装配到 scheduled_tasks.json 与三个 cron 工具", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.jobs).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of ["schedule_cron", "list_crons", "cancel_cron"]) {
      expect(names).toContain(name);
    }
  });

  it("cron 持久化任务在 buildHarness 时被加载", async () => {
    writeFileSync(
      path.join(tmpDir, ".scheduled_tasks.json"),
      JSON.stringify([
        {
          id: "cron_test1",
          cron: "* * * * *",
          prompt: "hi",
          recurring: true,
          durable: true,
          pending_delivery: false,
          last_fired: null,
        },
      ]),
    );
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.jobs?.cron.listJobs().map((job) => job.id)).toContain("cron_test1");
  });

  it("buildHarness wires agents", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.agents).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    for (const name of [
      "task", "spawn_teammate", "list_teammates", "send_message",
      "request_shutdown", "request_plan", "review_plan", "create_worktree",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("buildHarness wires extensions", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.extensions).toBeDefined();
    const names = harness.tools.list().map((tool) => tool.name);
    expect(names).toContain("load_skill");
    expect(names).toContain("connect_mcp");
  });

  it("buildHarness wires workflow and goal", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const harness = buildHarness(tmpDir);
    expect(harness.goal).toBeDefined();
    expect(harness.workflow).toBe(path.join(tmpDir, ".workflow_runtime"));
    expect(harness.tools.list().map((tool) => tool.name)).toContain("run_workflow");
  });
});

describe("parseCliArgs", () => {
  it("parses model and base-url flags", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs([
      "--model", "deepseek-chat",
      "--base-url", "https://example.com/v1",
    ]);
    expect(parsed.cli.model).toBe("deepseek-chat");
    expect(parsed.cli.base_url).toBe("https://example.com/v1");
    expect(parsed.prompt).toBeUndefined();
    expect(parsed.workdir).toBeUndefined();
  });

  it("parses workdir/timeout/max-output flags", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs([
      "--workdir", "C:\\tmp\\work",
      "--bash-timeout", "60",
      "--max-output-chars", "1000",
    ]);
    expect(parsed.workdir).toBe("C:\\tmp\\work");
    expect(parsed.cli.workdir).toBe("C:\\tmp\\work");
    expect(parsed.cli.bash_timeout).toBe("60");
    expect(parsed.cli.max_output_chars).toBe("1000");
  });

  it("parses -p prompt", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["-p", "你好，世界"]);
    expect(parsed.prompt).toBe("你好，世界");
    expect(parsed.cli).toEqual({});
  });
});
