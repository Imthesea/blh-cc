import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockWorkflowRunner } from "../../src/workflow/runtime.js";
import { WORKFLOWS } from "../../src/workflow/registry.js";
import { WorkflowInputError } from "../../src/workflow/schema.js";
import { runWorkflow } from "../../src/workflow/tool.js";

describe("runWorkflow", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wf-tool-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("unknown workflow returns error", async () => {
    await expect(
      runWorkflow("nope", {}, undefined, tmpDir, () => new MockWorkflowRunner(), WORKFLOWS),
    ).rejects.toThrow(WorkflowInputError);
  });

  it("run sample workflow", async () => {
    const result = await runWorkflow(
      "review-changes",
      { changes: "x = 1" },
      undefined,
      tmpDir,
      () => new MockWorkflowRunner(),
      WORKFLOWS,
    );
    expect(result.launched.status).toBe("async_launched");
    expect(result.result).toEqual({ confirmed: [] });
  });
});
