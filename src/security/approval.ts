import type { PermissionRule } from "./rules.js";
import { insertUserRule, matchRule } from "./rules.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("security.approval");

export interface ApprovalRequest {
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export type ApprovalAsker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** PreToolUse hook：返回 null 放行；返回字符串则阻断并作为工具结果 */
export type PermissionHook = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string | null>;

/** scheduled turn 上下文标志 */
export const approvalContext = { scheduledTurn: false };

export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
): PermissionHook {
  const asker: ApprovalAsker = ask ?? (async () => "deny");

  return async (tool, args) => {
    const target =
      (typeof args.command === "string" && args.command) ||
      (typeof args.path === "string" && args.path) ||
      "";
    const action = matchRule(rules, tool, target);
    if (action === "allow") return null;
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      return `denied by permission rule (${tool}: ${target})`;
    }
    if (approvalContext.scheduledTurn) {
      return "denied: cannot request approval from a scheduled turn";
    }
    const decision = await asker({ tool, target, args });
    if (decision === "deny") {
      log.warn("denied by user", { tool, target });
      return "denied by user";
    }
    if (decision === "always_allow" && target !== "") {
      const rule: PermissionRule = { tool, target, action: "allow" };
      insertUserRule(rules, rule);
      persistRule?.(rule);
      log.debug("always allowed", { tool, target });
    } else {
      log.debug("approved", { tool, target });
    }
    return null;
  };
}
