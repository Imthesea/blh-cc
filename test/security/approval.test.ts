import { describe, it, expect, vi } from "vitest";
import { makePermissionHook, approvalContext } from "../../src/security/approval.js";
import { DEFAULT_RULES, type PermissionRule } from "../../src/security/rules.js";

describe("makePermissionHook（结构化 asker）", () => {
  it("asker 返回 allow 时放行", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow");
    expect(await hook("bash", { command: "ls" })).toBeNull();
  });

  it("asker 返回 deny 时阻断", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "deny");
    expect(await hook("bash", { command: "ls" })).toBe("denied by user");
  });

  it("asker 拿到结构化的 tool/target/args", async () => {
    let received: unknown;
    const hook = makePermissionHook(DEFAULT_RULES, async (req) => {
      received = req;
      return "deny";
    });
    await hook("bash", { command: "npm install" });
    expect(received).toEqual({
      tool: "bash",
      target: "npm install",
      args: { command: "npm install" },
    });
  });

  it("always_allow 写入规则并回调 persistRule，且不覆盖硬性 deny", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));

    expect(await hook("bash", { command: "ls -la" })).toBeNull();
    const denyIdx = rules.findIndex((r) => r.action === "deny");
    const userIdx = rules.findIndex((r) => r.target === "ls -la");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeLessThan(userIdx);
    expect(persisted).toEqual([{ tool: "bash", target: "ls -la", action: "allow" }]);
  });

  it("always_allow 且 target 为空时退化为放行、不写规则", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));
    expect(await hook("bash", {})).toBeNull();
    expect(persisted).toEqual([]);
    expect(rules.length).toBe(DEFAULT_RULES.length);
  });

  it("scheduled turn 内拒绝交互审批且不调用 asker", async () => {
    const ask = vi.fn().mockResolvedValue("allow");
    const hook = makePermissionHook(DEFAULT_RULES, ask);
    approvalContext.scheduledTurn = true;
    try {
      await expect(hook("bash", { command: "ls" })).resolves.toBe(
        "denied: cannot request approval from a scheduled turn",
      );
      expect(ask).not.toHaveBeenCalled();
    } finally {
      approvalContext.scheduledTurn = false;
    }
  });

  it("文件工具用 path 作为 target 参与规则匹配", async () => {
    const rules: PermissionRule[] = [
      { tool: "write_file", target: "*.env", action: "deny" },
      { tool: "*", target: "*", action: "allow" },
    ];
    const hook = makePermissionHook(rules, async () => "allow");
    expect(await hook("write_file", { path: "prod.env" })).toBe(
      "denied by permission rule (write_file: prod.env)",
    );
  });
});
