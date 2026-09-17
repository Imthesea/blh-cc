import type { ServerResponse } from "node:http";
import type { AgentEvent } from "../core/events.js";

/** 服务器推给浏览器的所有事件：复用 agent 高层事件，另加审批与错误两类。 */
export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "error"; message: string };

/** 把一条事件序列化成 SSE 帧（event: <type> + data: <json>）。纯函数，便于单测。 */
export function serializeEvent(event: WebEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 维护当前所有 SSE 连接并广播事件。 */
export class SSEBroadcaster {
  private readonly clients = new Set<ServerResponse>();

  /** 接入一个新 SSE 客户端，返回取消订阅函数（会 end 连接）。 */
  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    return () => {
      this.clients.delete(res);
      res.end();
    };
  }

  broadcast(event: WebEvent): void {
    const frame = serializeEvent(event);
    for (const client of this.clients) client.write(frame);
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
