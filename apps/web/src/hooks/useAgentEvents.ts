import { useCallback, useEffect, useState } from "react";
import {
  connectEvents,
  getSession,
  listSessions,
  newSession,
  respondApproval,
  resumeSession,
  sendMessage,
  type ApprovalDecision,
  type ChatMessage,
  type SessionListItem,
} from "@blh/web-client";

/** 一次工具调用在前端展示所需的状态（参数 + 结果）。 */
export interface ToolEvent {
  id: string;
  name: string;
  arguments: string;
  output?: string;
  isError?: boolean;
}

/** 待用户处理的审批请求（对应 approval_requested 事件去掉 type）。 */
export interface ApprovalRequest {
  requestId: string;
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export interface AgentState {
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  streaming: string;
  approval: ApprovalRequest | null;
  error: string | null;
  busy: boolean;
  sessions: SessionListItem[];
  sessionId: string | null;
  workdir: string;
  send(text: string): Promise<void>;
  respond(decision: ApprovalDecision): Promise<void>;
  createSession(): Promise<void>;
  resume(file: string): Promise<void>;
}

export function useAgentEvents(): AgentState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [streaming, setStreaming] = useState("");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workdir, setWorkdir] = useState("");

  /** 从服务器取回权威消息与工作目录，并刷新会话列表。 */
  const refresh = useCallback(async () => {
    const info = await getSession();
    setSessionId(info.sessionId);
    setWorkdir(info.workdir);
    setMessages(info.messages);
    void listSessions().then(setSessions);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = connectEvents("/api/events", (event) => {
      switch (event.type) {
        case "turn_start":
          setBusy(true);
          setStreaming("");
          setToolEvents([]);
          break;
        case "assistant_text_delta":
          setStreaming((s) => s + event.text);
          break;
        case "tool_call":
          setToolEvents((ts) => [
            ...ts,
            { id: event.id, name: event.name, arguments: event.arguments },
          ]);
          break;
        case "tool_result":
          setToolEvents((ts) =>
            ts.map((t) =>
              t.id === event.id ? { ...t, output: event.output, isError: event.isError } : t,
            ),
          );
          break;
        case "turn_end":
          setBusy(false);
          setStreaming("");
          setToolEvents([]);
          void refresh();
          break;
        case "approval_requested":
          setApproval({
            requestId: event.requestId,
            tool: event.tool,
            target: event.target,
            args: event.args,
          });
          break;
        case "error":
          setError(event.message);
          break;
      }
    });
    return off;
  }, [refresh]);

  const send = useCallback(async (text: string) => {
    const userMessage: ChatMessage = { role: "user", content: text };
    setMessages((ms) => [...ms, userMessage]);
    setError(null);
    await sendMessage(text);
  }, []);

  const respond = useCallback(
    async (decision: ApprovalDecision) => {
      if (approval === null) return;
      const id = approval.requestId;
      setApproval(null);
      await respondApproval(id, decision);
    },
    [approval],
  );

  const createSession = useCallback(async () => {
    await newSession();
    await refresh();
  }, [refresh]);

  const resume = useCallback(
    async (file: string) => {
      await resumeSession(file);
      await refresh();
    },
    [refresh],
  );

  return {
    messages,
    toolEvents,
    streaming,
    approval,
    error,
    busy,
    sessions,
    sessionId,
    workdir,
    send,
    respond,
    createSession,
    resume,
  };
}
