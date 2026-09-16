import { POST_TOOL_USE, PRE_TOOL_USE } from "../core/hooks.js";
import type { HookBus } from "../core/hooks.js";
import type { ChatMessage, ChatProvider, Config, ToolCall } from "../core/types.js";
import { registerBuiltinTools } from "../tools/index.js";
import { ToolRegistry } from "../tools/registry.js";

const SUB_SYSTEM =
  "You are a coding agent. Complete the given task, then return a concise final answer.";
const MAX_SUBAGENT_TURNS = 30;

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 一次性嵌套 Agent Loop：新鲜 messages、无 task 工具、最多 30 轮，只返回最终文本。 */
export class SubagentRunner {
  readonly tools = new ToolRegistry();

  constructor(
    readonly provider: ChatProvider,
    readonly config: Config,
    readonly hooks: HookBus,
  ) {
    registerBuiltinTools(this.tools, config);
  }

  async run(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: SUB_SYSTEM },
      { role: "user", content: prompt },
    ];
    for (let turn = 0; turn < MAX_SUBAGENT_TURNS; turn++) {
      const assistant = await this.provider.chat(messages, this.tools.list());
      messages.push(assistant);
      const toolCalls: ToolCall[] = assistant.tool_calls ?? [];
      if (toolCalls.length === 0) {
        return assistant.content || "(no summary)";
      }
      for (const call of toolCalls) {
        const name = call.function.name;
        const input = parseArgs(call.function.arguments);
        const blocked = await this.hooks.firstBlock(PRE_TOOL_USE, { name, input });
        let result: string;
        if (blocked !== null) {
          result = blocked;
        } else {
          result = await this.tools.dispatch(name, input);
          await this.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return "Subagent stopped after 30 turns without a final answer.";
  }
}
