import type { ChatMessage } from "@blh/web-client";
import type { ToolEvent } from "../hooks/useAgentEvents";
import { ToolCallCard } from "./ToolCallCard";

export function ChatPanel(props: {
  messages: ChatMessage[];
  streaming: string;
  toolEvents: ToolEvent[];
  busy: boolean;
}) {
  const { messages, streaming, toolEvents, busy } = props;
  return (
    <div className="chat-panel">
      {messages
        .filter((m) => m.role !== "system")
        .map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role}`}>
            <span className="bubble-role">{m.role}</span>
            <span className="bubble-text">{m.content ?? ""}</span>
          </div>
        ))}
      {toolEvents.map((t) => (
        <ToolCallCard key={t.id} event={t} />
      ))}
      {(busy || streaming !== "") && (
        <div className="bubble bubble-assistant">
          <span className="bubble-role">assistant</span>
          <span className="bubble-text">{streaming !== "" ? streaming : "…"}</span>
        </div>
      )}
    </div>
  );
}
