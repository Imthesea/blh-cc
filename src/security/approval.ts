import type { PermissionRule } from "./rules.js";
import { matchRule } from "./rules.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("security.approval");

export type AskUser = (prompt: string) => Promise<string>;
/** PreToolUse hook：返回 null 放行；返回字符串则阻断并作为工具结果 */
export type PermissionHook = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string | null>;

/** scheduled turn 上下文标志（等价 Python 非主线程检测） */
export const approvalContext = { scheduledTurn: false };

export function makePermissionHook(
  rules: PermissionRule[],
  askUser?: AskUser,
): PermissionHook {
  const ask: AskUser =
    askUser ??
    (async () => {
      // M0 默认：无交互环境一律视为拒绝（REPL 接入 readline 后由任务 12 注入真实 askUser）
      return "";
    });

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
    const answer = (await ask(`allow ${tool}(${target})? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      log.debug("approved", { tool, target });
      return null;
    }
    log.warn("denied by user", { tool, target });
    return "denied by user";
  };
}
