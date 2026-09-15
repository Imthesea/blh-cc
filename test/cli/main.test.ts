import { mkdtempSync, rmSync } from "node:fs";
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
});
