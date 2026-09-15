/** 与模型交互的消息格式（对齐 OpenAI chat.completions） */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

/** 工具参数的 JSON Schema（M0 仅支持 object 顶层） */
export type ToolParameters = {
  type: "object";
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  handler: ToolHandler;
}

export interface Config {
  apiKey: string;
  baseUrl?: string;
  model: string;
  workdir: string;
  bashTimeout: number;
  maxOutputChars: number;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage>;
}
