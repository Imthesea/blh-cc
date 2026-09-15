import type { ChatMessage, ToolCall } from "./types.js";
import type { Harness } from "./harness.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";
import { isPromptTooLong } from "../providers/openai.js";

const MAX_REACTIVE_RETRIES = 1;

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

export async function agentLoop(
  harness: Harness,
  messages: ChatMessage[],
  activeRequest = "",
): Promise<void> {
  const systemMessage: ChatMessage =
    messages[0] ?? { role: "system", content: harness.systemPrompt };
  let reactiveRetries = 0;
  for (;;) {
    const compactor = harness.compactor;
    if (compactor) {
      const prepared = await compactor.prepare(messages, activeRequest);
      messages.splice(0, messages.length, ...prepared);
      restoreSystem(messages, systemMessage);
    }
    let message: ChatMessage;
    try {
      message = await harness.provider.chat(messages, harness.tools.list());
      reactiveRetries = 0;
    } catch (error) {
      if (compactor && isPromptTooLong(error) && reactiveRetries < MAX_REACTIVE_RETRIES) {
        const compacted = await compactor.reactiveCompact(messages, activeRequest);
        messages.splice(0, messages.length, ...compacted);
        restoreSystem(messages, systemMessage);
        reactiveRetries += 1;
        continue;
      }
      throw error;
    }
    messages.push(message);
    const toolCalls: ToolCall[] = message.tool_calls ?? [];
    if (toolCalls.length === 0) return;

    let compactRequested = false;
    let usedTodo = false;
    for (const call of toolCalls) {
      const name = call.function.name;
      const input = parseToolArguments(call.function.arguments);
      let result: string;
      if (compactor && name === "compact") {
        // compact 由 loop 拦截：先闭合本批次，再压缩，不走 dispatch/hooks
        result = "Compaction requested after this tool batch.";
        compactRequested = true;
      } else {
        const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
        if (blocked !== null) {
          result = blocked;
        } else {
          result = await harness.tools.dispatch(name, input);
          await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
        }
        if (name === "todo_write") usedTodo = true;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    const todoManager = harness.todoManager;
    if (todoManager) {
      const reminder = todoManager.noteRound(usedTodo);
      const last = messages[messages.length - 1];
      if (reminder && last?.role === "tool") {
        last.content = (last.content ?? "") + reminder;
      }
    }

    if (compactRequested && compactor) {
      const compacted = await compactor.compactHistory(messages, activeRequest);
      messages.splice(0, messages.length, ...compacted);
      restoreSystem(messages, systemMessage);
    }
  }
}

/** 压缩/摘要会把 messages 换成不含 system 的新数组，此处按需把初始 system 挂回队首 */
function restoreSystem(messages: ChatMessage[], systemMessage: ChatMessage): void {
  if (messages[0]?.role !== "system") messages.unshift(systemMessage);
}
