import { describe, it, expect } from "vitest";

const LIVE = !!process.env.BLH_LIVE;

describe.skipIf(!LIVE)("live API smoke", () => {
  it("answers a trivial prompt", async () => {
    const { buildHarness } = await import("../../src/cli/main.js");
    const { lastAssistantText } = await import("../../src/core/loop.js");
    const harness = buildHarness();
    const messages = await harness.runTurn("Reply with exactly: pong");
    expect(lastAssistantText(messages).toLowerCase()).toContain("pong");
  }, 120000);
});
