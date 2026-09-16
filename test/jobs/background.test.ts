import { describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/jobs/background.js";

function makeManager(): BackgroundManager {
  return new BackgroundManager(process.cwd());
}

async function waitStatus(
  manager: BackgroundManager,
  taskId: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.tasks[taskId]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${taskId} to reach ${status}`);
}

describe("BackgroundManager", () => {
  it("start returns bg id and tracks running", () => {
    const manager = makeManager();
    const bgId = manager.start("echo hi");
    expect(bgId.startsWith("bg_")).toBe(true);
    expect(manager.tasks[bgId]?.status).toBe("running");
  });

  it("start rejects empty command", () => {
    expect(() => makeManager().start("   ")).toThrow(Error);
  });

  it("collect returns completed notification", async () => {
    const manager = makeManager();
    const bgId = manager.start("echo hello");
    await waitStatus(manager, bgId, "completed");
    const notifications = manager.collect();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(`<task_id>${bgId}</task_id>`);
    expect(notifications[0]).toContain("<status>completed</status>");
    expect(notifications[0]).toContain("hello");
  });

  it("collect empty when nothing done", () => {
    expect(makeManager().collect()).toEqual([]);
  });

  it("failed command marks failed", async () => {
    const manager = makeManager();
    const bgId = manager.start("exit 1");
    await waitStatus(manager, bgId, "failed");
    const notifications = manager.collect();
    expect(notifications[0]).toContain("<status>failed</status>");
  });

  it("collect is one-shot", async () => {
    const manager = makeManager();
    const bgId = manager.start("echo once");
    await waitStatus(manager, bgId, "completed");
    expect(manager.collect()).toHaveLength(1);
    expect(manager.collect()).toEqual([]);
  });
});
