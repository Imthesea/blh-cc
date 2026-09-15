import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "blh-bash-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function runScript(script: string, timeout = 120, maxOutputChars = 30000) {
  await fs.writeFile(path.join(dir, "s.js"), script);
  const { runBash } = await import("../../src/tools/bash.js");
  return runBash(dir, timeout, maxOutputChars, { command: "node s.js" });
}

describe("runBash", () => {
  it("captures stdout", async () => {
    const out = await runScript("console.log('hello')");
    expect(out.trim()).toBe("hello");
  });
  it("appends non-zero exit code", async () => {
    const out = await runScript("console.log('oops'); process.exit(3)");
    expect(out).toContain("oops");
    expect(out).toContain("(exit code 3)");
  });
  it("returns (exit code N) for empty output", async () => {
    const out = await runScript("process.exit(7)");
    expect(out).toBe("(exit code 7)");
  });
  it("times out long-running commands", async () => {
    const out = await runScript("setTimeout(() => {}, 30000)", 1);
    expect(out).toBe("error: command timed out after 1s");
  }, 15000);
  it("truncates huge output", async () => {
    const out = await runScript("console.log('x'.repeat(500))", 120, 100);
    expect(out).toContain("... [truncated, 501 chars total]");
    expect(out.length).toBeLessThan(200);
  });
});
