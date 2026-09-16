import { describe, expect, it } from "vitest";
import { WORKFLOWS, sampleWorkflow } from "../../src/workflow/registry.js";

describe("WORKFLOWS", () => {
  it("registry contains sample", () => {
    expect(WORKFLOWS.has("review-changes")).toBe(true);
    const entry = WORKFLOWS.get("review-changes");
    expect(entry?.[0].name).toBe("review-changes");
    expect(entry?.[1]).toBe(sampleWorkflow);
  });
});
