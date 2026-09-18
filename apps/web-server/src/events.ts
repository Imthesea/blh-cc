import type { AgentEvent } from "./types.js";
import type { AgentEventListener, WebEventBus } from "./types.js";
import { createLogger } from "@blh/logger";

const log = createLogger("web-server.events");

/** 极简发布订阅总线：把 harness 的高层事件转发给 SSE 广播。 */
export class EventBus implements WebEventBus {
  private readonly listeners: AgentEventListener[] = [];

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        // 单个监听器出错不影响其它监听器，但需记录避免静默丢事件
        log.warn("event listener failed", {
          type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

