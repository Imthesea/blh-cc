import { useState } from "react";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { ChatPanel } from "./components/ChatPanel";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { SessionSidebar } from "./components/SessionSidebar";

export function App() {
  const state = useAgentEvents();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      <SessionSidebar
        sessions={state.sessions}
        activeId={state.sessionId}
        loading={state.sessionLoading}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onNew={() => void state.createSession()}
        onResume={(file) => void state.resume(file)}
        onDelete={(file) => void state.deleteSession(file)}
      />
      <main className="main">
        <ChatPanel
          messages={state.messages}
          streaming={state.streaming}
          toolEvents={state.toolEvents}
          busy={state.busy}
          approval={state.approval}
        />
        {state.error !== null && <div className="error-banner">{state.error}</div>}
        <InputBar busy={state.busy} onSend={(text) => void state.send(text)} />
      </main>
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
