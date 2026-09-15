import { describe, it, expect, vi } from "vitest";
import { makePermissionHook } from "../../src/security/approval.js";
import { DEFAULT_RULES } from "../../src/security/rules.js";

describe("makePermissionHook", () => {
  it("blocks denied commands with rule message", async () => {
    const hook = makePermissionHook(DEFAULT_RULES);
    const result = await hook("bash", { command: "git push --force" });
    expect(result).toBe("denied by permission rule (bash: git push --force)");
  });

  it("asks and allows on y", async () => {
    const askUser = vi.fn().mockResolvedValue("y");
    const hook = makePermissionHook(DEFAULT_RULES, askUser);
    const result = await hook("bash", { command: "ls" });
    expect(askUser).toHaveBeenCalledWith("allow bash(ls)? [y/N] ");
    expect(result).toBeNull();
  });

  it("asks and denies on empty/other answer", async () => {
    const askUser = vi.fn().mockResolvedValue("");
    const hook = makePermissionHook(DEFAULT_RULES, askUser);
    await expect(hook("bash", { command: "ls" })).resolves.toBe("denied by user");
  });

  it("accepts yes case-insensitively", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "YES");
    await expect(hook("bash", { command: "ls" })).resolves.toBeNull();
  });

  it("allows file tools without asking", async () => {
    const askUser = vi.fn();
    const hook = makePermissionHook(DEFAULT_RULES, askUser);
    await expect(hook("read_file", { path: "a.txt" })).resolves.toBeNull();
    expect(askUser).not.toHaveBeenCalled();
  });

  it("uses path as target for file tools in deny message", async () => {
    const rules = [{ tool: "write_file", target: "*.env", action: "deny" as const }];
    const hook = makePermissionHook(rules);
    await expect(hook("write_file", { path: "prod.env" })).resolves.toBe(
      "denied by permission rule (write_file: prod.env)",
    );
  });
});
