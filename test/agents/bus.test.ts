import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageBus, isValidAgentName } from "../../src/agents/bus.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "bus-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeBus(): MessageBus {
  return new MessageBus(path.join(tmpDir, ".mailboxes"));
}

describe("MessageBus", () => {
  it("send and read is destructive", () => {
    const bus = makeBus();
    bus.send("alice", "bob", "hi", "message");
    const messages = bus.readInbox("bob");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe("alice");
    expect(messages[0]?.content).toBe("hi");
    expect(bus.readInbox("bob")).toEqual([]);
  });

  it("send rejects invalid recipient", () => {
    const bus = makeBus();
    expect(() => bus.send("alice", "../etc", "x")).toThrow("Invalid mailbox recipient");
  });

  it("isValidAgentName", () => {
    expect(isValidAgentName("alice-1")).toBe(true);
    expect(isValidAgentName("../x")).toBe(false);
    expect(isValidAgentName("a b")).toBe(false);
  });

  it("waitForMessages wakes on send", async () => {
    const bus = makeBus();
    const waiter = bus.waitForMessages("bob", 2000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    bus.send("alice", "bob", "hello");
    const messages = await waiter;
    expect(messages[0]?.content).toBe("hello");
  });

  it("waitForMessages times out", async () => {
    const bus = makeBus();
    await expect(bus.waitForMessages("bob", 30)).resolves.toEqual([]);
  });
});
