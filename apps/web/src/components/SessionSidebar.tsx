import type { SessionListItem } from "@blh/web-client";
import { BlhLogo } from "./Logo";
import { IconPanelLeft, IconPlus } from "./icons";

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  collapsed: boolean;
  onToggle(): void;
  onNew(): void;
  onResume(file: string): void;
}) {
  const { sessions, activeId, loading, collapsed, onToggle, onNew, onResume } = props;
  return (
    <aside className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}>
      <div className="logo-row">
        {!collapsed && (
          <button type="button" className="brand" aria-label="新建会话" onClick={onNew}>
            <span className="brand-identity">
              <span className="brand-mark">
                <BlhLogo size={24} />
              </span>
              <span className="brand-name">blh</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggle}
        >
          <IconPanelLeft size={16} />
        </button>
      </div>

      <button type="button" className="new-session" aria-label="新建会话" onClick={onNew} disabled={loading}>
        <IconPlus size={14} />
        <span className="new-session-label">{loading ? "加载中…" : "新建会话"}</span>
      </button>

      <div className="session-region">
        {collapsed ? null : (
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.file}>
                <button
                  className={`session-row${s.file === activeId ? " selected" : ""}`}
                  onClick={() => onResume(s.file)}
                  disabled={loading}
                >
                  <span className="session-title">{s.preview !== "" ? s.preview : s.file}</span>
                </button>
              </li>
            ))}
            {sessions.length === 0 && !loading && <li className="session-empty">暂无会话</li>}
          </ul>
        )}
      </div>
    </aside>
  );
}
