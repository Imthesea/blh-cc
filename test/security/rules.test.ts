import { describe, it, expect } from "vitest";
import { matchRule, DEFAULT_RULES, SKIP_PERMISSIONS_RULES } from "../../src/security/rules.js";

describe("DEFAULT_RULES", () => {
  it("has exactly 6 rules", () => {
    expect(DEFAULT_RULES).toHaveLength(6);
  });
});

describe("matchRule", () => {
  it("denies git push --force variants", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "git push --force origin main")).toBe("deny");
  });

  it("denies rm -rf /", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /")).toBe("deny");
    expect(matchRule(DEFAULT_RULES, "bash", "rm -rf /home")).toBe("deny");
  });

  it("asks for other bash commands", () => {
    expect(matchRule(DEFAULT_RULES, "bash", "ls -la")).toBe("ask");
    expect(matchRule(DEFAULT_RULES, "bash", "npm install")).toBe("ask");
  });

  it("allows non-bash tools", () => {
    expect(matchRule(DEFAULT_RULES, "read_file", "/etc/passwd")).toBe("allow");
    expect(matchRule(DEFAULT_RULES, "write_file", "a.txt")).toBe("allow");
  });

  it("defaults to ask when no rule matches", () => {
    expect(matchRule([], "bash", "ls")).toBe("ask");
  });

  it("matches tool name via fnmatch", () => {
    const rules = [{ tool: "read_*", target: "*", action: "deny" as const }];
    expect(matchRule(rules, "read_file", "x")).toBe("deny");
  });

  it("mcp_tools_ask_by_default", () => {
    expect(matchRule(DEFAULT_RULES, "mcp__docs__search", "")).toBe("ask");
    expect(matchRule(DEFAULT_RULES, "connect_mcp", "")).toBe("ask");
  });
});

describe("SKIP_PERMISSIONS_RULES", () => {
  it("allows bash by default but keeps hard denies", () => {
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "dir")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "pnpm test")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "git push --force")).toBe("deny");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "bash", "rm -rf /")).toBe("deny");
  });

  it("keeps non-bash behavior unchanged", () => {
    expect(matchRule(SKIP_PERMISSIONS_RULES, "read_file", "x.ts")).toBe("allow");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "mcp__docs__search", "")).toBe("ask");
    expect(matchRule(SKIP_PERMISSIONS_RULES, "connect_mcp", "")).toBe("ask");
  });
});
