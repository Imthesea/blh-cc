import type { ToolRegistry } from "../tools/registry.js";
import type { SkillLoader } from "./skills.js";
import type { MCPRegistry } from "./mcp.js";

export function registerExtensionTools(
  registry: ToolRegistry,
  skills: SkillLoader,
  mcp: MCPRegistry,
): void {
  registry.register({
    name: "load_skill",
    description: "Load the full SKILL.md content by skill name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args) => skills.load(typeof args.name === "string" ? args.name : ""),
  });

  registry.register({
    name: "connect_mcp",
    description: "Connect to an MCP server and discover its tools.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["name", "command"],
    },
    handler: (args) =>
      mcp.connect(
        typeof args.name === "string" ? args.name : "",
        typeof args.command === "string" ? args.command : "",
        Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : undefined,
      ),
  });
}
