import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { SkillLoader } from "../../src/extensions/skills.js";
import { MCPRegistry } from "../../src/extensions/mcp.js";
import { registerExtensionTools } from "../../src/extensions/tools.js";

describe("registerExtensionTools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ext-tools-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers_load_skill_and_connect_mcp", () => {
    const registry = new ToolRegistry();
    const skills = new SkillLoader(path.join(tmpDir, "skills"));
    const mcp = new MCPRegistry(registry, ".");
    registerExtensionTools(registry, skills, mcp);
    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("load_skill");
    expect(names).toContain("connect_mcp");
  });
});
