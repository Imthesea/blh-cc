import { describe, it, expect } from "vitest";
import { matchRule, DEFAULT_RULES } from "../../src/security/rules.js";

describe("DEFAULT_RULES", () => {
  it("has exactly 4 rules in M0", () => {
    expect(DEFAULT_RULES).toHaveLength(4);
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

  it("matches tool name exactly or * (M0: no fnmatch on tool name)", () => {
    const rules = [{ tool: "read_*", target: "*", action: "deny" as const }];
    // M0 语义：工具名不做 fnmatch，"read_*" 不等于 "read_file" → 落到下一条/默认
    expect(matchRule(rules, "read_file", "x")).toBe("ask");
  });
});
