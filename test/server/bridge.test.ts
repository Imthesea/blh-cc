import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { serializeEvent, SSEBroadcaster, type WebEvent } from "../../src/server/bridge.js";

describe("serializeEvent", () => {
  it("序列化文本增量", () => {
    const event: WebEvent = { type: "assistant_text_delta", text: "你好" };
    expect(serializeEvent(event)).toBe('event: assistant_text_delta\ndata: {"text":"你好"}\n\n');
  });

  it("序列化无载荷事件", () => {
    expect(serializeEvent({ type: "turn_start" })).toBe("event: turn_start\ndata: {}\n\n");
  });

  it("序列化审批事件", () => {
    const event: WebEvent = {
      type: "approval_requested",
      requestId: "r1",
      tool: "bash",
      target: "ls",
      args: { command: "ls" },
    };
    expect(serializeEvent(event)).toBe(
      'event: approval_requested\ndata: {"requestId":"r1","tool":"bash","target":"ls","args":{"command":"ls"}}\n\n',
    );
  });
});

describe("SSEBroadcaster", () => {
  it("订阅后广播、取消订阅后不再广播", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn();
    const res = { writeHead: vi.fn(), write, end: vi.fn() } as unknown as ServerResponse;

    const off = broadcaster.subscribe(res);
    expect(broadcaster.clientCount).toBe(1);
    broadcaster.broadcast({ type: "turn_end" });

    off();
    expect(broadcaster.clientCount).toBe(0);
    broadcaster.broadcast({ type: "turn_end" });

    const frames = write.mock.calls.map((c) => c[0] as string);
    expect(frames.filter((f) => f.includes("event: turn_end"))).toHaveLength(1);
  });
});
