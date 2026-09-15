import OpenAI from "openai";
import type {
  ChatMessage,
  ChatProvider,
  Config,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
import { withRetry } from "./retry.js";

/** 最小化的 client 结构：provider 只依赖 chat.completions.create，便于测试注入 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
        options?: { timeout?: number },
      ): Promise<OpenAI.ChatCompletion>;
    };
  };
}

function toOpenAIMessage(message: ChatMessage): OpenAI.ChatCompletionMessageParam {
  const content = message.content ?? "";
  switch (message.role) {
    case "system":
      return { role: "system", content };
    case "user":
      return { role: "user", content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      };
    case "tool":
      return { role: "tool", content, tool_call_id: message.tool_call_id ?? "" };
  }
}

function fromOpenAIMessage(message: OpenAI.ChatCompletionMessage): ChatMessage {
  const toolCalls: ToolCall[] = [];
  for (const call of message.tool_calls ?? []) {
    // 防御 custom tool call 联合类型：本项目只使用 function tool
    if (call.type !== "function") continue;
    toolCalls.push({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    });
  }
  return {
    role: "assistant",
    content: message.content,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

export class OpenAIProvider implements ChatProvider {
  private readonly client: ChatCompletionsClient;

  constructor(
    private readonly config: Config,
    client?: ChatCompletionsClient,
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      });
  }

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
    const response = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: messages.map(toOpenAIMessage),
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
        },
        { timeout: 600_000 },
      ),
    );
    const message = response.choices[0]?.message;
    if (!message) throw new Error("provider returned no choices");
    return fromOpenAIMessage(message);
  }
}

const PROMPT_TOO_LONG_KEYWORDS = [
  "prompt_too_long",
  "too many tokens",
  "context length",
  "context_length_exceeded",
  "maximum context",
  "reduce the length",
] as const;

/** 启发式判定上下文超长：HTTP 400 + 错误体关键词（各兼容端格式不一） */
export function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error)) return false;
  if (error.status !== 400) return false;
  const text = error.message.toLowerCase();
  return PROMPT_TOO_LONG_KEYWORDS.some((keyword) => text.includes(keyword));
}
