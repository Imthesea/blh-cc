import type { ApprovalDecision } from "@blh/web-client";
import type { ApprovalRequest } from "../hooks/useAgentEvents";

export function ApprovalModal(props: {
  approval: ApprovalRequest | null;
  onRespond(decision: ApprovalDecision): void;
}) {
  const { approval, onRespond } = props;
  if (approval === null) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>工具需要授权</h2>
        <p>
          <strong>{approval.tool}</strong>
          {approval.target !== "" ? `：${approval.target}` : ""}
        </p>
        <pre className="modal-args">{JSON.stringify(approval.args, null, 2)}</pre>
        <div className="modal-actions">
          <button onClick={() => onRespond("deny")}>拒绝</button>
          <button onClick={() => onRespond("allow")}>允许</button>
          <button onClick={() => onRespond("always_allow")}>总是允许</button>
        </div>
      </div>
    </div>
  );
}
