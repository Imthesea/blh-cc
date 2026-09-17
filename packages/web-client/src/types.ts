export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_end" };

export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "error"; message: string };

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

export interface SessionInfo {
  sessionId: string | null;
  workdir: string;
  messages: ChatMessage[];
}

export interface SessionListItem {
  file: string;
  mtime: number;
  preview: string;
}
