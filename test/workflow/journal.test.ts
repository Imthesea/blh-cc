import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowJournal } from "../../src/workflow/journal.js";
import { MISS, WorkflowInputError } from "../../src/workflow/schema.js";

describe("WorkflowJournal", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wf-journal-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("key is deterministic", () => {
    const journal = new WorkflowJournal("wf_x_0000000000000001", false, tmpDir);
    const a = journal.key("agent", "label", "prompt", undefined);
    const b = journal.key("agent", "label", "prompt", undefined);
    expect(a).toBe(b);
    expect(a).toMatch(/^agent-\d{10}$/);
  });

  it("record and resume", () => {
    const journal = new WorkflowJournal("wf_x_0000000000000001", false, tmpDir);
    journal.record("agent-0000000001", { ok: true });
    journal.close();

    const resumed = new WorkflowJournal("wf_x_0000000000000001", true, tmpDir);
    expect(resumed.cached("agent-0000000001")).toEqual({ ok: true });
  });

  it("cached miss", () => {
    const journal = new WorkflowJournal("wf_x_0000000000000001", false, tmpDir);
    expect(journal.cached("agent-0000000001")).toBe(MISS);
  });

  it("resume missing journal raises", () => {
    expect(
      () => new WorkflowJournal("wf_x_0000000000000001", true, tmpDir),
    ).toThrow(WorkflowInputError);
  });

  it("invalid record raises", () => {
    writeFileSync(path.join(tmpDir, "wf_x_0000000000000001.journal.jsonl"), "not json\n");
    expect(
      () => new WorkflowJournal("wf_x_0000000000000001", true, tmpDir),
    ).toThrow(WorkflowInputError);
  });
});
