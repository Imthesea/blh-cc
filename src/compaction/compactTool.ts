import type { ToolRegistry } from "../tools/registry.js";

export function registerCompactTool(registry: ToolRegistry): void {
  registry.register({
    name: "compact",
    description: "Summarize earlier conversation to free context space.",
    parameters: { type: "object", properties: {} },
    handler: async () => "Compaction requested after this tool batch.",
  });
}
