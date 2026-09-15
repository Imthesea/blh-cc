import type { ChatMessage, ToolCall } from "./types.js";
import type { Harness } from "./harness.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 tool_call 的 JSON arguments：非法 JSON 或非对象一律返回 {} */
export function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

export async function agentLoop(harness: Harness, messages: ChatMessage[]): Promise<void> {
  for (;;) {
    const message = await harness.provider.chat(messages, harness.tools.list());
    messages.push(message);
    const toolCalls: ToolCall[] = message.tool_calls ?? [];
    if (toolCalls.length === 0) return;

    for (const call of toolCalls) {
      const name = call.function.name;
      const input = parseToolArguments(call.function.arguments);
      const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
      let result: string;
      if (blocked !== null) {
        result = blocked;
      } else {
        result = await harness.tools.dispatch(name, input);
        await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
}
