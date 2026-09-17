import type { ToolEvent } from "../hooks/useAgentEvents";

export function ToolCallCard({ event }: { event: ToolEvent }) {
  const running = event.output === undefined;
  return (
    <div className={`tool-card${event.isError === true ? " tool-card-error" : ""}`}>
      <div className="tool-card-head">
        <strong>{event.name}</strong>
        <span>{running ? "执行中…" : event.isError === true ? "失败" : "完成"}</span>
      </div>
      <pre className="tool-card-args">{event.arguments}</pre>
      {event.output !== undefined && <pre className="tool-card-output">{event.output}</pre>}
    </div>
  );
}
