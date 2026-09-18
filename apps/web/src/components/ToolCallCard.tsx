import type { ThinkingStep } from "./turns";

export function ToolCallCard({ step }: { step: ThinkingStep }) {
  const running = step.output === undefined;
  return (
    <div className={`tool-card${step.isError === true ? " tool-card-error" : ""}`}>
      <div className="tool-card-head">
        <strong>{step.name ?? "tool"}</strong>
        <span>{running ? "执行中…" : step.isError === true ? "失败" : "完成"}</span>
      </div>
      {step.arguments !== undefined && <pre className="tool-card-args">{step.arguments}</pre>}
      {step.output !== undefined && <pre className="tool-card-output">{step.output}</pre>}
    </div>
  );
}
