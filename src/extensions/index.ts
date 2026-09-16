import type { SkillLoader } from "./skills.js";
import type { MCPRegistry } from "./mcp.js";

export class Extensions {
  constructor(
    readonly skills: SkillLoader,
    readonly mcp: MCPRegistry,
  ) {}

  systemPromptSection(): string {
    const parts: string[] = [];
    const catalog = this.skills.catalog();
    if (catalog !== "(no skills found)") parts.push("Skills available:\n" + catalog);
    const section = this.mcp.systemPromptSection();
    if (section) parts.push(section);
    return parts.join("\n\n");
  }
}
