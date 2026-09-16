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

/** 工具参数 JSON Schema 属性（递归，支持 enum / array items / 嵌套 object） */
export type JsonSchemaProperty = {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

export type ToolParameters = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
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
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage>;
}
