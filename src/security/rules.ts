import { fnmatch } from "../tools/glob.js";

export type PermissionAction = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  target: string;
  action: PermissionAction;
}

export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", target: "git push --force*", action: "deny" },
  { tool: "bash", target: "rm -rf /*", action: "deny" },
  { tool: "bash", target: "*", action: "ask" },
  { tool: "mcp__*", target: "*", action: "ask" },
  { tool: "connect_mcp", target: "*", action: "ask" },
  { tool: "*", target: "*", action: "allow" },
];

/** 跳过权限询问：仅把 bash 的默认 ask 放宽为 allow，硬拦截(deny)保持不变。 */
export const SKIP_PERMISSIONS_RULES: PermissionRule[] = DEFAULT_RULES.map((rule) =>
  rule.tool === "bash" && rule.action === "ask" ? { ...rule, action: "allow" } : rule,
);

export function matchRule(
  rules: PermissionRule[],
  tool: string,
  target: string,
): PermissionAction {
  for (const rule of rules) {
    if (rule.tool !== "*" && !fnmatch(tool, rule.tool)) continue;
    if (fnmatch(target, rule.target)) return rule.action;
  }
  return "ask";
}

/** 把用户规则插到硬性 deny 之后、默认 ask/allow 之前。 */
export function insertUserRule(rules: PermissionRule[], rule: PermissionRule): void {
  const idx = rules.findIndex((r) => r.action !== "deny");
  rules.splice(idx === -1 ? rules.length : idx, 0, rule);
}
