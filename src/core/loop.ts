import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";
import type { Harness } from "./harness.js";
import type { EventBus } from "./events.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";
import { isPromptTooLong } from "../providers/openai.js";
import type { GoalController } from "../goals/controller.js";
import type { StopDecision } from "../goals/types.js";
import { createLogger } from "@blh/logger";

const log = createLogger("core.loop");

/** 提示词过长时，允许「被动压缩后重试」的最大次数 */
const MAX_REACTIVE_RETRIES = 1;

/** 判断一个值是不是普通对象（排除 null 和数组），用于校验解析出的 JSON */
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

/** 从后往前找最后一条 assistant 消息，返回它的文本内容；没有则返回空串 */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

/**
 * 核心对话循环：反复调用模型，直到模型不再要求调用工具为止。
 * 每轮先压缩历史、注入后台任务结果，再请求模型；
 * 模型返回工具调用则逐个执行，否则评估目标是否满足后决定继续还是结束。
 */
export async function agentLoop(
  harness: Harness,
  messages: ChatMessage[],
  activeRequest = "",
  events?: EventBus,
): Promise<void> {
  const systemMessage: ChatMessage =
    messages[0] ?? { role: "system", content: harness.systemPrompt };
  let reactiveRetries = 0;
  await events?.emit({ type: "turn_start" });
  for (;;) {
    log.debug("turn start", { messages: messages.length });
    const compactor = harness.compactor;
    if (compactor) {
      const prepared = await compactor.prepare(messages, activeRequest);
      messages.splice(0, messages.length, ...prepared);
      restoreSystem(messages, systemMessage);
    }
    if (harness.jobs) {
      harness.jobs.injectBackgroundResults(messages);
    }
    let message: ChatMessage;
    const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
    try {
      if (streamAvailable) {
        try {
          message = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events);
        } catch (error) {
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          message = await harness.provider.chat(messages, harness.tools.list());
        }
      } else {
        message = await harness.provider.chat(messages, harness.tools.list());
      }
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
    harness.sessionStore?.append(message);
    const toolCalls: ToolCall[] = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const decision = await evaluateGoalStop(harness, messages);
      if (decision !== null && decision.action === "block") {
        const reminder: ChatMessage = { role: "user", content: goalReminder(harness.goal, decision) };
        messages.push(reminder);
        harness.sessionStore?.append(reminder);
        continue;
      }
      await events?.emit({ type: "turn_end" });
      return;
    }

    let compactRequested = false;
    let usedTodo = false;
    for (const call of toolCalls) {
      const name = call.function.name;
      log.debug("tool call", { tool: name });
      const input = parseToolArguments(call.function.arguments);
      await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
      let result: string;
      if (compactor && name === "compact") {
        // compact 由 loop 拦截：先闭合本批次，再压缩，不走 dispatch/hooks
        result = "Compaction requested after this tool batch.";
        compactRequested = true;
      } else if (
        harness.jobs !== undefined &&
        name === "bash" &&
        input["run_in_background"] === true
      ) {
        const blocked = await harness.hooks.firstBlock(PRE_TOOL_USE, { name, input });
        if (blocked !== null) {
          result = blocked;
        } else {
          try {
            result = harness.jobs.startBackground(String(input["command"] ?? ""));
          } catch (error) {
            result = `error: ${error instanceof Error ? error.message : String(error)}`;
          }
          await harness.hooks.trigger(POST_TOOL_USE, { name, input, output: result });
        }
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
      await events?.emit({ type: "tool_result", id: call.id, name, output: result, isError: result.startsWith("error:") });
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      harness.sessionStore?.append(toolMessage);
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

/** 一轮对话收尾时评估目标是否已达成；没有目标控制器则直接返回 null */
async function evaluateGoalStop(harness: Harness, messages: ChatMessage[]): Promise<StopDecision | null> {
  const goal = harness.goal;
  if (goal === undefined) return null;
  const backgroundRunning = harness.jobs !== undefined && harness.jobs.background.hasRunning();
  return goal.evaluateAfterTurn(messages, backgroundRunning);
}

/** 目标尚未达成、需要让模型继续干活时，拼出给模型的提示文本 */
function goalReminder(goal: GoalController | undefined, decision: StopDecision): string {
  const condition = goal?.active?.condition ?? "";
  return (
    `[Goal still active]\nCondition: ${condition}\n` +
    `Evaluator: ${decision.reason}\n` +
    "Continue working and surface the missing evidence."
  );
}

/** 消费 Provider 底层流，转发文本增量，返回拼好的最终消息。 */
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
): Promise<ChatMessage> {
  const stream = provider.stream!(messages, tools);
  for await (const event of stream) {
    if (event.type === "text_delta") {
      await events.emit({ type: "assistant_text_delta", text: event.text });
    } else if (event.type === "done") {
      return event.message;
    }
  }
  throw new Error("provider stream ended without a done event");
}
