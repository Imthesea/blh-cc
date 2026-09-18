# blh 项目整体检视报告

- 检视日期：2026-09-18
- 检视范围：前端层（apps/web）、后端层（apps/web-server + packages/）、agent 核心层（src/）
- 检视方式：并行分派三个检视智能体 + 本地基线检查

## 基线检查结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（0 错误） |
| `pnpm lint` | 通过（0 错误） |
| `pnpm test` | 380 通过 / 1 跳过（51 个测试文件） |

基线健康，问题集中在「安全边界」「资源泄漏」「并发竞态」「前后端类型漂移」四类，均可通过静态检视发现。

---

## 一、Agent 核心层（src/）

### 严重问题

1. **`--dangerously-skip-permissions` 下的危险命令拦截形同虚设（安全）**
   - `src/security/rules.ts:11-23`
   - 只硬 deny 两条字符串：`git push --force*`、`rm -rf /*`。`fnmatch`（`src/tools/glob.ts:5-20`）是「子串 + `*` 跨任意字符」匹配，无法命中 `rm -rf /`、`rm -rf --no-preserve-root /`、`find / -delete`、`git push -f origin main`、`git push --force-with-lease`、`git push origin +main`。破坏性命令可完全绕过拦截。

2. **bash 超时定时器未清理、未 unref，阻塞进程退出（资源泄漏）**
   - `src/tools/bash.ts:43-49`、`src/jobs/background.ts:53-58`
   - 命令正常结束后从不 `clearTimeout`、从不 `unref()`，每个 bash 调用遗留一个最长存活 120s 的定时器。`-p` 模式下进程最多滞留 ~120s 才退出。对照 `jobs/runtime.ts`、`agents/team.ts` 的定时器都正确 `unref()`。

3. **Unix 下超时只杀 shell 进程、不杀进程组（孤儿进程）**
   - `src/tools/bash.ts:53-65`、`src/jobs/background.ts:63-73`
   - 非 Windows 分支 `child.kill("SIGKILL")` 只杀 `sh -c`，子进程（如 `sleep 999`）成孤儿。建议 `detached: true` + `process.kill(-pid)`。

4. **`approvalContext.scheduledTurn` 全局标志并发竞态（安全）**
   - `src/security/approval.ts:24`；写入点 `src/core/harness.ts:107,115,127,131`、`src/agents/teammate.ts:262-271`
   - 进程级可变单例，teammate 后台并发「读旧值 → 置 true → finally 恢复」与主循环无锁共享。竞态下可能让计划任务误弹交互式审批。

5. **MCP 连接失败时已注册工具不回收（正确性）**
   - `src/extensions/mcp.ts:139-175`
   - 中途某工具注册失败直接 return，前面已注册的 `mcp__*` 工具与 `origins` 不回滚，`clients` 也未登记，残留工具指向已关闭 client。

6. **MCP 子进程无 error/exit 监听（健壮性）**
   - `src/extensions/mcp.ts:20-46`
   - 无 `process.on("error")/on("exit")`，命令不存在时抛 unhandled error 崩溃；服务退出后 pending 请求只能等 30s 超时。

7. **Hook 异常不隔离，中断整轮并丢结果**
   - `src/core/hooks.ts:46-56,59-69`、`src/core/loop.ts:140`
   - `HookBus.trigger` 不捕获异常，`POST_TOOL_USE` 若抛错会跳过 `tool_result` 事件、消息 push、session 落盘，且整轮终止。与 `EventBus.emit`（有 try/catch）不一致。

8. **`TeamRuntime.leadTick` 无异常捕获（unhandled rejection）**
   - `src/agents/team.ts:84-92`
   - `setInterval(() => { void this.leadTick(); })` 只有 try/finally 无 catch，抛错成 unhandled rejection。

9. **文件工具默认放行 + 符号链接逃逸（安全）**
   - `src/tools/files.ts:6-13`、`src/security/rules.ts:17`
   - 文件工具因默认 `allow` 不经过审批；`safePath` 只做词法 `path.resolve` 前缀判断，不解析 `fs.realpath`，workdir 内指向外部的 symlink 可被跟随逃逸。

10. **`-p` 非交互模式默认拒绝全部 bash（可用性）**
    - `src/cli/main.ts:175`、`src/cli/harness.ts:60`
    - `askUser` 为 undefined，`makePermissionHook` 默认 deny，非交互模式任何 ask 类 bash 命令静默被拒，除非显式 `--dangerously-skip-permissions`。

### 可优化点

- `isError` 用 `startsWith("error:")` 判定脆弱，`src/core/loop.ts:144`。
- `isPromptTooLong` 只识别 400，`src/providers/openai.ts:229-234`，413/422 不触发压缩。
- 非 function 类型 tool_call 被静默丢弃，`src/providers/openai.ts:50-66`。
- `read_file` 无大小/limit 上限，大文件 OOM 风险，`src/tools/files.ts:33`。
- `toInt` 允许负数，`src/core/config.ts:60-67`。
- `glob` 未转义 `[`/`]`，未闭合 `[` 构造非法正则，`src/tools/glob.ts:6-18`。
- 流式重试只覆盖 create 阶段，流中断靠整体重发，可能重复计费。
- `ContextCompactor.prepare` 每轮多次 JSON.stringify，`src/compaction/compactor.ts:323-338`。
- `runTurn` 每轮额外 2 次模型调用（memory recall + extract），`src/core/harness.ts:90-96`。
- `SessionStore.append` 每条消息 `appendFileSync`，`latest()` 在 sort 比较器里重复 `statSync`，`src/session/store.ts`。
- 重复代码：`parseToolArguments`/`parseArgs` 三份；`runBash` 与 `background.ts` 重复 shell 选择/`killTree`/截断。
- 魔数散落：30 轮、200ms 轮询、500 字摘要、120s 超时等，缺统一常量。

### 测试缺口

MCP 失败路径（error/exit/回滚）、bash 超时清理与进程组、symlink 逃逸、`scheduledTurn` 竞态、`-p` 默认 deny、413/422 重试、hook 抛异常降级、`leadTick` 异常、REPL readline 关闭。

---

## 二、后端层（apps/web-server + packages/）

### 严重问题

1. **静态文件流缺错误处理，可能崩溃进程**
   - `apps/web-server/src/http.ts:109-120`
   - `statSync` 与 `createReadStream` 间有竞态窗口，`createReadStream` 无 `error` 监听，未处理客户端断开。

2. **SSE 广播无背压，慢客户端内存无界增长**
   - `apps/web-server/src/bridge.ts:31-44`
   - 忽略 `res.write()` 返回值，无 drain/丢弃慢客户端机制，`assistant_text_delta` 高频事件下卡死客户端导致内存泄漏。

3. **无 Host/Origin 校验 + GET 端点无鉴权（DNS rebinding）**
   - `apps/web-server/src/http.ts:129-167,268-272`
   - 仅绑 127.0.0.1 但不校验 Host/Origin、无 token；GET 端点（session/sessions/events）不校验 CSRF 头，DNS rebinding 可读取会话敏感内容。

4. **请求体无大小限制（OOM）**
   - `apps/web-server/src/http.ts:57-75`
   - `readBody` 无条件累积整个请求体，不检查 Content-Length、无上限。

### 可优化点

- `/api/sessions/:file` 的 load 未包 try/catch（`http.ts:162-165`），ENOENT 变 500 而非 404。
- 静态文件路径未做 URL 解码（`http.ts:110-112`），含空格/中文文件名 404。
- 外层 catch 未检查 `res.headersSent`（`http.ts:282-288`），二次 writeHead 抛错成未处理 rejection。
- `EventBus.emit` 静默吞监听器异常且不记日志（`events.ts:20-22`）。
- `dispose` 为死代码，`create` 不清理旧 handle（`session.ts:87-90`）。
- 日志无脱敏机制（`packages/logger/src/format.ts`）。
- `/api/log` 字段无大小校验，恶意前端可写爆磁盘（`http.ts:192-221`）。
- **类型重复定义**：`AgentEvent`/`WebEvent`/`ApprovalDecision`/`ChatMessage` 在 web-server 与 web-client 各一份，易漂移，建议抽 `@blh/shared`。
- `EVENT_TYPES` 手工枚举与 `WebEvent` 联合类型重复（`packages/web-client/src/sse.ts:6-14`）。
- `isLogLevel` 与 `parseLevel` 逻辑重复。
- 硬编码：端口 8123、地址 127.0.0.1、审批超时、`.blh` 目录名散落多处。
- `http.ts` 职责过重（约 290 行），建议按资源拆分。
- `sse.ts` 类型断言宽松，无兜底 onmessage（`packages/web-client/src/sse.ts:23`）。

### 日志系统问题

- 终端格式不含日期/毫秒，字段值不加引号，含空格时无法解析（`format.ts:30-44`）。
- 日期口径不一致：`fileDate` 用本地时间，`formatFile` 用 `toISOString()`（UTC）。
- 每条日志 `appendFileSync` 同步落盘，阻塞事件循环（`node.ts:30-38`）。
- 缺关联 ID（trace/correlation）贯穿「HTTP 请求 → runTurn → SSE 广播」链路。
- `appendRawEntry` 不过级别过滤，前端可绕过级别写入 debug 噪声。

### 测试缺口

审批超时/自动拒绝分支、`serveStatic` 完全无测试、`/api/sessions/:file` 成功路径、`EventBus.emit` 异常隔离、web-client 完全无测试且缺 vitest 配置。

---

## 三、前端层（apps/web）

### 严重问题

1. **SSE 断流/重连无 UI 兜底，busy 永久卡死**
   - `apps/web/src/hooks/useAgentEvents.ts:83-132`
   - 断流后 `busy` 保持 true，`streaming` 残留，InputBar 永久禁用，无错误提示。底层 `sse.ts` 只 `log.warn`，不暴露连接状态。

2. **`refresh()` 无竞态保护，旧响应覆盖新状态**
   - `apps/web/src/hooks/useAgentEvents.ts:63-77`
   - 无 AbortController/请求序号，旧 `getSession()` 晚返回会覆盖最新状态；组件卸载后无 mounted 守卫。

3. **聊天消息用数组下标作 key**
   - `apps/web/src/components/ChatPanel.tsx:17`
   - 非纯追加场景下 DOM 复用错位、内容闪烁，应改用稳定 id。

4. **会话创建/恢复失败无感**
   - `apps/web/src/hooks/useAgentEvents.ts:163-182`
   - catch 只 `log.error`，无 UI 反馈，无 loading 态，可重复点击触发重复请求。

### 可优化点

- 发送按钮双击/重复提交窗口（`InputBar.tsx:26-28`）。
- `send` 失败回滚依赖对象引用（`useAgentEvents.ts:143`）。
- 流式文本字符串累加，长回复 O(n²)（`useAgentEvents.ts:93`）。
- `ChatPanel` 每帧 `filter`、审批等待期误显「assistant: …」（`ChatPanel.tsx:14-30`）。
- 会话侧边栏无 loading/empty 态（`SessionSidebar.tsx:15-26`）。
- 会话高亮 `sessionId` 与 `file` 语义可能不一致（`SessionSidebar.tsx:19`）。
- 审批弹窗缺可访问性：无 `role="dialog"`/焦点陷阱/Escape（`ApprovalModal.tsx:9-25`）。
- 聊天面板缺 `aria-live` 实时播报（`ChatPanel.tsx:12-31`）。
- 硬编码端口/路径散落多处（vite/playwright/mock/hook）。
- `playwright.config.ts` mock `reuseExistingServer: false` 易 EADDRINUSE（`playwright.config.ts:18`）。
- mock 服务器不覆盖 tool_call/tool_result/approval_requested/error 事件（`mock-server.mjs:40-64`）。
- 全局无 ErrorBoundary（`App.tsx`、`main.tsx`），组件抛错即白屏。

### 测试缺口

e2e 仅 2 条用例，未覆盖工具卡片、审批弹窗、错误横幅、侧边栏、断流重连、输入禁用等关键路径。

---

## 四、优先级汇总

### 高优先级（安全 / 数据丢失 / 进程崩溃）

| 序号 | 层 | 问题 |
|---|---|---|
| 1 | agent | skip-permissions 危险命令拦截可绕过 |
| 2 | agent | 文件工具默认放行 + symlink 逃逸 |
| 3 | agent | bash 超时定时器未清理/未 unref（进程滞留） |
| 4 | agent | approvalContext 全局标志并发竞态 |
| 5 | 后端 | DNS rebinding 无 Host/Origin 校验 |
| 6 | 后端 | SSE 无背压（内存泄漏） |
| 7 | 后端 | 静态文件流无 error 监听（崩溃） |
| 8 | 后端 | 请求体无大小上限（OOM） |
| 9 | 前端 | SSE 断流 busy 永久卡死 |
| 10 | 前端 | refresh 竞态覆盖新状态 |

### 中优先级（健壮性 / 正确性）

- agent：MCP 生命周期（error/exit 监听、注册回滚）、Hook 异常隔离、`leadTick` 异常、`-p` 默认 deny 提示。
- 后端：日志脱敏、关联 ID、同步写盘、类型抽共享包。
- 前端：消息稳定 key、会话操作失败反馈、ErrorBoundary、审批可访问性。

### 低优先级（可维护性 / 性能）

- agent：重复代码抽取、魔数集中、配置负数校验。
- 后端：`http.ts` 拆分、硬编码集中、日志格式统一。
- 前端：`useMemo`/`useCallback` 优化、字符串累加改数组、端口收敛。
