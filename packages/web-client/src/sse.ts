import type { WebEvent } from "./types.js";

const EVENT_TYPES = [
  "turn_start",
  "assistant_text_delta",
  "tool_call",
  "tool_result",
  "turn_end",
  "approval_requested",
  "error",
] as const;

/** 订阅 SSE 事件流，返回取消订阅函数（会关闭 EventSource）。 */
export function connectEvents(url: string, onEvent: (event: WebEvent) => void): () => void {
  const es = new EventSource(url);
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        onEvent({ type, ...data } as WebEvent);
      } catch {
        onEvent({ type: "error", message: `bad SSE payload for ${type}` });
      }
    });
  }
  return () => es.close();
}
