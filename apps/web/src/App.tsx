import { useAgentEvents } from "./hooks/useAgentEvents";
import { ChatPanel } from "./components/ChatPanel";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { SessionSidebar } from "./components/SessionSidebar";

export function App() {
  const state = useAgentEvents();

  return (
    <div className="app">
      <header className="topbar">
        <h1>blh 工作台</h1>
        <span className="workdir">{state.workdir}</span>
      </header>
      <div className="body">
        <SessionSidebar
          sessions={state.sessions}
          activeId={state.sessionId}
          onNew={() => void state.createSession()}
          onResume={(file) => void state.resume(file)}
        />
        <main className="main">
          <ChatPanel
            messages={state.messages}
            streaming={state.streaming}
            toolEvents={state.toolEvents}
            busy={state.busy}
          />
          {state.error !== null && <div className="error-banner">{state.error}</div>}
          <InputBar busy={state.busy} onSend={(text) => void state.send(text)} />
        </main>
      </div>
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
