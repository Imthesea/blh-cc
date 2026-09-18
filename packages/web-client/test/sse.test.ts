import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectEvents } from "../src/sse.js";

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Listener[]>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.[0]?.({ data });
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectEvents", () => {
  it("注册事件监听并返回关闭函数", () => {
    const onEvent = vi.fn();
    const close = connectEvents("/api/events", onEvent);
    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toBe("/api/events");
    expect(es.listeners.has("turn_start")).toBe(true);
    expect(es.listeners.has("agent_error")).toBe(true);
    close();
    expect(es.closed).toBe(true);
  });

  it("合法负载触发 onEvent", () => {
    const onEvent = vi.fn();
    connectEvents("/api/events", onEvent);
    const es = FakeEventSource.instances.at(-1)!;
    es.emit("assistant_text_delta", JSON.stringify({ text: "hi" }));
    expect(onEvent).toHaveBeenCalledWith({ type: "assistant_text_delta", text: "hi" });
  });

  it("非法负载触发 error 事件", () => {
    const onEvent = vi.fn();
    connectEvents("/api/events", onEvent);
    const es = FakeEventSource.instances.at(-1)!;
    es.emit("tool_call", "not-json");
    expect(onEvent).toHaveBeenCalledWith({
      type: "agent_error",
      message: "bad SSE payload for tool_call",
    });
  });

  it("连接状态回调：onopen/onerror", () => {
    const onStatus = vi.fn();
    connectEvents("/api/events", vi.fn(), onStatus);
    const es = FakeEventSource.instances.at(-1)!;
    es.onopen?.();
    es.onerror?.();
    expect(onStatus).toHaveBeenNthCalledWith(1, "open");
    expect(onStatus).toHaveBeenNthCalledWith(2, "error");
  });
});
