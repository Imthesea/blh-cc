import type { SessionListItem } from "@blh/web-client";

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  onNew(): void;
  onResume(file: string): void;
}) {
  const { sessions, activeId, loading, onNew, onResume } = props;
  return (
    <aside className="sidebar">
      <button className="sidebar-new" onClick={onNew} disabled={loading}>
        {loading ? "加载中…" : "新建会话"}
      </button>
      <ul className="sidebar-list">
        {sessions.map((s) => (
          <li key={s.file}>
            <button
              className={`sidebar-item${s.file === activeId ? " sidebar-item-active" : ""}`}
              onClick={() => onResume(s.file)}
              disabled={loading}
            >
              {s.preview !== "" ? s.preview : s.file}
            </button>
          </li>
        ))}
        {sessions.length === 0 && !loading && <li className="sidebar-empty">暂无会话</li>}
      </ul>
    </aside>
  );
}
