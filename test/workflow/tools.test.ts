import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { MockWorkflowRunner } from "../../src/workflow/runtime.js";
import { WORKFLOWS } from "../../src/workflow/registry.js";
import { registerWorkflowTools } from "../../src/workflow/tools.js";

describe("registerWorkflowTools", () => {
  it("registers run workflow", () => {
    const registry = new ToolRegistry();
    const store = mkdtempSync(path.join(os.tmpdir(), "wf-tools-"));
    try {
      registerWorkflowTools(registry, store, () => new MockWorkflowRunner(), WORKFLOWS);
      expect(registry.list().map((tool) => tool.name)).toContain("run_workflow");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
});
