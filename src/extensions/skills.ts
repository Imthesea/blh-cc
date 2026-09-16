import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

interface SkillEntry {
  name: string;
  description: string;
  content: string;
}

export class SkillLoader {
  private readonly skills = new Map<string, SkillEntry>();

  constructor(readonly skillsDir: string) {
    this.scan();
  }

  static parseFrontmatter(text: string): [Record<string, unknown>, string] {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return [{}, text];
    const closing = lines.findIndex((line, i) => i > 0 && line === "---");
    if (closing === -1) return [{}, text];
    const frontmatter = lines.slice(1, closing).join("\n");
    const body = lines.slice(closing + 1).join("\n").trim();
    let meta: unknown;
    try {
      meta = parseYaml(frontmatter) ?? {};
    } catch {
      meta = {};
    }
    const normalized =
      typeof meta === "object" && meta !== null && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {};
    return [normalized, body];
  }

  scan(): void {
    this.skills.clear();
    if (!existsSync(this.skillsDir)) return;
    const root = path.resolve(this.skillsDir);
    for (const dir of readdirSync(this.skillsDir).sort()) {
      const manifest = path.join(this.skillsDir, dir, "SKILL.md");
      if (!existsSync(manifest)) continue;
      if (!path.resolve(manifest).startsWith(root + path.sep)) continue;
      const content = readFileSync(manifest, "utf-8");
      const [meta, body] = SkillLoader.parseFrontmatter(content);
      const name = String(meta.name ?? "").trim() || dir;
      const firstLine = body.split("\n")[0] ?? "";
      const description =
        String(meta.description ?? "").trim() ||
        firstLine.replace(/^#+\s*/, "").split(/\s+/).join(" ");
      this.skills.set(name, { name, description, content });
    }
  }

  catalog(): string {
    if (this.skills.size === 0) return "(no skills found)";
    return [...this.skills.values()]
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");
  }

  load(name: string): string {
    const skill = this.skills.get(name);
    if (skill) return skill.content;
    const available = [...this.skills.keys()].join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }
}
