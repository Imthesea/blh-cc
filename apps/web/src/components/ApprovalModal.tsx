import { useEffect } from "react";
import type { ApprovalDecision } from "@blh/web-client";
import type { ApprovalRequest } from "../hooks/useAgentEvents";

export function ApprovalModal(props: {
  approval: ApprovalRequest | null;
  onRespond(decision: ApprovalDecision): void;
}) {
  const { approval, onRespond } = props;

  useEffect(() => {
    if (approval === null) return;
    function onKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") onRespond("deny");
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [approval, onRespond]);

  if (approval === null) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <h2 id="approval-title">工具需要授权</h2>
        <p>
          <strong>{approval.tool}</strong>
          {approval.target !== "" ? `：${approval.target}` : ""}
        </p>
        <pre className="modal-args">{JSON.stringify(approval.args, null, 2)}</pre>
        <div className="modal-actions">
          <button onClick={() => onRespond("deny")}>拒绝</button>
          <button className="primary" onClick={() => onRespond("allow")}>允许</button>
          <button className="primary" onClick={() => onRespond("always_allow")}>总是允许</button>
        </div>
      </div>
    </div>
  );
}
