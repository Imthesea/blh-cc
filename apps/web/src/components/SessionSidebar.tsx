import type { SessionListItem } from "@blh/web-client";

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  onNew(): void;
  onResume(file: string): void;
}) {
  const { sessions, activeId, onNew, onResume } = props;
  return (
    <aside className="sidebar">
      <button className="sidebar-new" onClick={onNew}>
        新建会话
      </button>
      <ul className="sidebar-list">
        {sessions.map((s) => (
          <li key={s.file}>
            <button
              className={`sidebar-item${s.file === activeId ? " sidebar-item-active" : ""}`}
              onClick={() => onResume(s.file)}
            >
              {s.preview !== "" ? s.preview : s.file}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
