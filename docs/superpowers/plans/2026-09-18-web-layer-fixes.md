# 前端层修复计划（apps/web + packages/web-client）

- 日期：2026-09-18
- 范围：前端层 `apps/web/`、`packages/web-client/src/sse.ts`
- 依据：`docs/2026-09-18-code-review.md` 三、前端层章节
- 状态：已完成

---

## 任务 1：SSE 断流恢复 + 连接状态暴露（严重）

现状 `packages/web-client/src/sse.ts:30-32` 只 `log.warn` 不暴露连接状态；`apps/web/src/hooks/useAgentEvents.ts:83-132` 断流后 `busy` 永久为 true，`streaming` 残留，InputBar 永久禁用，无错误提示。

修复：`connectEvents` 增加可选 `onStatus` 回调（`"open" | "error"`）；`useAgentEvents` 收到 `error` 时重置 `busy`/`streaming` 并展示重连提示，收到 `open` 时清除该提示。

- [x] **步骤 1**：`sse.ts` 增加 `onStatus` 参数，`onopen`/`onerror` 触发回调
- [x] **步骤 2**：`useAgentEvents` 传入 `onStatus`，error 时重置状态并提示
- [x] **步骤 3**：补 `packages/web-client/test/sse.test.ts` 的 onStatus 用例
- [x] **步骤 4**：回归 web-client 测试

## 任务 2：refresh 竞态保护 + mounted 守卫（严重）

现状 `useAgentEvents.ts:63-77`：无请求序号，旧 `getSession()` 晚返回会覆盖新状态；无 mounted 守卫，卸载后 setState。

修复：`refreshSeq` ref 递增序号，仅最新一次应用状态；`disposed` ref 在 cleanup 置位，所有 setState 前检查。

- [x] **步骤 1**：加 `refreshSeq` + `disposed` ref
- [x] **步骤 2**：`refresh` 内应用状态前校验序号与 disposed
- [x] **步骤 3**：`listSessions` 回调同样校验

## 任务 3：消息稳定 id（严重）

现状 `ChatPanel.tsx:17` 用数组下标 `key={i}`；`send` 失败回滚 `useAgentEvents.ts:143` 依赖对象引用，refresh 后失效。

修复：引入 `UiMessage`（`ChatMessage` + 客户端生成 `id`），`refresh`/`send` 生成 id；`ChatPanel` 用 `m.id` 作 key；`send` 失败按 id 回滚。

- [x] **步骤 1**：定义 `UiMessage` 类型与 `nextId`
- [x] **步骤 2**：`messages` 状态改 `UiMessage[]`，refresh/send 生成 id
- [x] **步骤 3**：`send` 失败按 id 删除
- [x] **步骤 4**：`ChatPanel` 改用 `m.id` 作 key

## 任务 4：会话创建/恢复失败反馈 + loading（严重）

现状 `useAgentEvents.ts:163-182`：catch 只 `log.error`，无 UI 反馈、无 loading 态、可重复点击。

修复：加 `sessionLoading` 状态；`createSession`/`resume` 失败 `setError`，成功前禁用按钮；`SessionSidebar` 加 loading/empty 态。

- [x] **步骤 1**：加 `sessionLoading` 状态并返回
- [x] **步骤 2**：createSession/resume 失败 setError + finally 清 loading
- [x] **步骤 3**：App 传 `loading`，SessionSidebar 展示 loading/empty 并禁用新建按钮

## 任务 5：可优化点

- [x] **步骤 1**：发送双击防护——加 `submitting` 状态，返回 `busy = busy || submitting`
- [x] **步骤 2**：streaming 用 ref 数组累加，减少字符串反复拼接
- [x] **步骤 3**：ChatPanel 过滤用 `useMemo`；审批等待期不误显 "assistant: …"（传入 approval）
- [x] **步骤 4**：ChatPanel 加 `aria-live`
- [x] **步骤 5**：ApprovalModal 加 `role="dialog"`/`aria-modal`/`aria-labelledby` + Escape 关闭
- [x] **步骤 6**：新增 ErrorBoundary，main.tsx 包裹 App
- [x] **步骤 7**：mock-server 补 tool_call/tool_result/approval_requested/error 事件；`playwright.config.ts` mock 改 `reuseExistingServer: true`

## 任务 6：测试缺口（e2e）

- [x] **步骤 1**：工具卡片展示（tool_call/tool_result）
- [x] **步骤 2**：审批弹窗出现 + 允许/拒绝
- [x] **步骤 3**：错误横幅
- [x] **步骤 4**：发送后输入禁用

## 任务 7：收尾验证

- [x] **步骤 1**：`pnpm typecheck`（root + web + web-client）PASS
- [x] **步骤 2**：`pnpm lint` PASS
- [x] **步骤 3**：`pnpm build`（web 构建）PASS
- [x] **步骤 4**：`pnpm test`（root + web-client）全绿
- [x] **步骤 5**：e2e 测试通过

---

## 验证中额外发现并修复

- **SSE 保留事件名冲突（严重）**：`WebEvent` 的 `error` 事件类型与 `EventSource` 原生连接错误事件同名。服务端下发 `event: error` 时，浏览器同时触发 `addEventListener("error")` 与 `es.onerror`，导致 `onStatus("error")` 用「连接中断，正在自动重连…」覆盖真实的错误消息。修复：将 SSE 错误事件重命名为 `agent_error`（涉及 `web-client/types.ts`、`web-client/sse.ts`、`web-server/types.ts`、`web-server/http.ts`、`web/hooks/useAgentEvents.ts`、`web/e2e/mock-server.mjs`、`web-client/test/sse.test.ts`）。
- **StrictMode 双挂载 disposed 复位**：`disposed` effect 仅在 cleanup 置位、未在 mount 复位，导致双挂载后 `disposed` 卡在 true，`refresh` 全部被跳过。

---

## 范围外（架构级/重构，本次不做）

- 硬编码端口/路径集中（vite/playwright/mock/hook 多处 `8123`/`5173`）
- 抽 `@blh/shared` 共享类型（`ChatMessage` 加服务端 id 而非客户端生成，消除 `AgentEvent`/`WebEvent` 前后端重复）
- `useMemo`/`useCallback` 全量性能优化
- 端口收敛与配置外置
