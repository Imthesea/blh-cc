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
  { tool: "*", target: "*", action: "allow" },
];

export function matchRule(
  rules: PermissionRule[],
  tool: string,
  target: string,
): PermissionAction {
  for (const rule of rules) {
    // M0：工具名精确匹配或 "*"（不用 fnmatch 匹配工具名——那是 M6）
    if (rule.tool !== tool && rule.tool !== "*") continue;
    if (fnmatch(target, rule.target)) return rule.action;
  }
  return "ask";
}
