import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "../../src/extensions/skills.js";

function writeSkill(root: string, name: string, content: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8");
  return dir;
}

describe("SkillLoader.parseFrontmatter", () => {
  it("parse_frontmatter basic", () => {
    const [meta, body] = SkillLoader.parseFrontmatter(
      "---\nname: code-review\ndescription: 审查代码\n---\n正文",
    );
    expect(meta).toEqual({ name: "code-review", description: "审查代码" });
    expect(body).toBe("正文");
  });

  it("parse_frontmatter missing", () => {
    const [meta, body] = SkillLoader.parseFrontmatter("无 frontmatter");
    expect(meta).toEqual({});
    expect(body).toBe("无 frontmatter");
  });
});

describe("SkillLoader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "skills-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scan_catalog_and_load", () => {
    writeSkill(tmpDir, "alpha", "---\nname: a\ndescription: 第一个\n---\nA body");
    writeSkill(tmpDir, "beta", "---\nname: b\ndescription: 第二个\n---\nB body");
    const loader = new SkillLoader(tmpDir);
    expect(loader.catalog()).toContain("a: 第一个");
    expect(loader.catalog()).toContain("b: 第二个");
    expect(loader.load("a")).toBe("---\nname: a\ndescription: 第一个\n---\nA body");
  });

  it("load_unknown_lists_available", () => {
    writeSkill(tmpDir, "alpha", "---\nname: a\ndescription: 第一个\n---\n");
    const loader = new SkillLoader(tmpDir);
    expect(loader.load("nope")).toContain("Unknown skill 'nope'");
    expect(loader.load("nope")).toContain("a");
  });
});
