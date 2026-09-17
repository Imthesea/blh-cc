import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type TurnLock, type WebTurnRunner } from "../../src/server/session.js";
import { SessionStore } from "../../src/session/store.js";
import { ApprovalCoordinator } from "../../src/server/approval.js";
import type { ChatMessage } from "../../src/core/types.js";
import type { WebEvent } from "../../src/server/bridge.js";

function fakeLock(): TurnLock {
  return { withLock: async <T,>(fn: () => Promise<T>) => fn() };
}

function fakeRunner(): WebTurnRunner {
  return {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: vi.fn(async (messages: ChatMessage[], text: string) => {
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: `reply:${text}` });
    }),
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-session-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("SessionManager", () => {
  it("create 建立会话并挂到 runner", () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);

    expect(handle.messages).toEqual([{ role: "system", content: "sys" }]);
    expect(runner.sessionStore?.path).toBe(handle.file);
    expect(manager.list()).toEqual([handle]);
    expect(manager.get(handle.id)).toBe(handle);
  });

  it("runTurn 在锁内跑轮次", async () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);

    await manager.runTurn(handle.id, "hi");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(handle.messages.map((m) => m.content)).toContain("reply:hi");
  });

  it("resume 载入历史消息并继续同一文件", () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const store = SessionStore.create(tmpDir);
    store.append({ role: "user", content: "old" });

    const handle = manager.resume(tmpDir, path.basename(store.path));
    expect(handle.messages.map((m) => m.content)).toEqual(["sys", "old"]);
    expect(runner.sessionStore?.path).toBe(store.path);
  });

  it("resume 拒绝路径穿越", () => {
    const manager = new SessionManager(fakeRunner(), fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    expect(() => manager.resume(tmpDir, "../etc/passwd")).toThrow("invalid session file");
  });

  it("approve 应答待审批请求", async () => {
    const events: WebEvent[] = [];
    const approvals = new ApprovalCoordinator((e) => events.push(e));
    const manager = new SessionManager(fakeRunner(), fakeLock(), (e) => events.push(e), approvals);

    const promise = approvals.ask({ tool: "bash", target: "ls", args: {} });
    const requestId = (events[0] as { requestId: string }).requestId;
    expect(manager.approve(requestId, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");
  });

  it("dispose 清空当前会话", () => {
    const manager = new SessionManager(fakeRunner(), fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);
    return manager.dispose(handle.id).then(() => {
      expect(manager.list()).toEqual([]);
    });
  });
});
