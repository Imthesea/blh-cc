import { useMemo } from "react";
import type { ApprovalRequest, ToolEvent, UiMessage } from "../hooks/useAgentEvents";
import { ToolCallCard } from "./ToolCallCard";

export function ChatPanel(props: {
  messages: UiMessage[];
  streaming: string;
  toolEvents: ToolEvent[];
  busy: boolean;
  approval: ApprovalRequest | null;
}) {
  const { messages, streaming, toolEvents, busy, approval } = props;
  const visible = useMemo(() => messages.filter((m) => m.role !== "system"), [messages]);
  // 审批等待期不误显 "assistant: …"（此时 busy 仍为 true，但不应展示占位气泡）
  const showPending = streaming !== "" || (busy && approval === null);
  return (
    <div className="chat-panel" aria-live="polite">
      {visible.map((m) => (
        <div key={m.id} className={`bubble bubble-${m.role}`}>
          <span className="bubble-role">{m.role}</span>
          <span className="bubble-text">{m.content ?? ""}</span>
        </div>
      ))}
      {toolEvents.map((t) => (
        <ToolCallCard key={t.id} event={t} />
      ))}
      {showPending && (
        <div className="bubble bubble-assistant">
          <span className="bubble-role">assistant</span>
          <span className="bubble-text">{streaming !== "" ? streaming : "…"}</span>
        </div>
      )}
    </div>
  );
}
