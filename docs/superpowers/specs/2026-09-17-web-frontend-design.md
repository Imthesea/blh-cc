# Web 前端设计：交互式工作台

- 日期：2026-09-17
- 状态：待审查

## 1. 背景与目标

blh-claude-code-ts 目前只有终端界面（REPL 交互 + `-p` 单次），没有 web 界面。本次参考 deepseek-harness 的前端架构，为本项目新增一个 **web 交互式工作台**，在浏览器里提供：

- 聊天：输入指令、流式查看回复。
- 工具调用可视化：实时看到模型调用了哪个工具、参数与结果。
- 权限审批：待审批工具弹卡片，用户点「允许 / 拒绝 / 总是允许」。
- 会话历史：复用 `.sessions/` 落盘，浏览器里可查看、恢复历史会话。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 范围 | 交互式工作台（聊天 + 工具可视化 + 审批 + 会话历史） |
| 技术栈 | React 18 + Vite + TypeScript |
| 参考深度 | 模块化分层（薄入口 + 独立包；不引入 Cordis 依赖注入/插件框架） |
| 工程结构 | pnpm workspace 多包（核心留在根包） |
| 通信协议 | SSE（服务器→浏览器）+ HTTP（浏览器→服务器） |
| 会话模型 | 单会话，接口预留多会话扩展口子 |
| 会话历史 | 复用 `.sessions/` JSONL 落盘 + 可查看/恢复 |
| 审批交互 | 允许 / 拒绝 / 总是允许（「总是允许」写权限规则） |
| 安全绑定 | 仅监听 127.0.0.1 |
| 启动命令 | `blh web` 子命令 |
| 工作目录 | 共享启动目录（可 `--workdir` 指定） |
| HTTP 实现 | 用 Node 内置 `node:http`，不引入 Express/Fastify 等框架 |

## 3. 参考 deepseek-harness 的取舍

deepseek-harness 前端是「Vite + React + Cordis（依赖注入）+ 插件/模块加载器 + UI slots/renderer」的完整插件化 GUI。本项目的核心是单进程、无依赖注入的简单架构，因此**只参考它的工程分层与通信形态，不引入 Cordis 插件体系**：

| deepseek-harness | 本项目对应做法 |
|------------------|----------------|
| `apps/web`（Vite 薄入口） | `apps/web`（React 前端） |
| `packages/client/web`（浏览器端 shell） | `packages/web-client`（共享类型 + SSE/fetch 客户端） |
| `packages/host/webserver`（node:http 服务器） | 根包 `src/server/`（node:http 服务器，跑在 blh 进程内） |
| SSE（HMR 事件流）+ HTTP API | SSE + HTTP（同上） |
| Cordis DI / 插件加载 / UI slots | **不引入** |

## 4. 包结构与工程布局

```
blh-claude-code-ts/
├── package.json                 # 根包 blh（核心 + CLI，现有）
├── pnpm-workspace.yaml          # 新增 packages: ["packages/*", "apps/*"]
├── tsconfig.json / tsconfig.build.json
├── src/
│   ├── cli/                     # 现有：REPL / -p / buildHarness
│   ├── core/                    # 现有：harness / loop / events / ...
│   ├── security/                # 现有：rules / approval（本次泛化 approval）
│   └── server/                  # 新增：web 后端（Node，跑在 blh 进程内）
│       ├── index.ts             #   导出 startWebServer
│       ├── http.ts              #   node:http 服务器 + 路由 + SSE + 静态文件
│       ├── session.ts           #   会话管理（单会话，接口预留多会话）
│       ├── bridge.ts            #   EventBus → SSE 桥接
│       └── approval.ts          #   审批端点 + pending Promise + 规则持久化
├── packages/
│   └── web-client/              # @blh/web-client（浏览器共享库）
│       ├── src/types.ts         #   SSE 事件类型 + API 请求/响应类型
│       ├── src/sse.ts           #   EventSource 封装
│       └── src/api.ts           #   fetch 封装
└── apps/
    └── web/                     # @blh/web（React 前端，Vite 构建）
        ├── src/
        │   ├── main.tsx
        │   ├── App.tsx
        │   ├── hooks/useAgentEvents.ts
        │   └── components/
        │       ├── ChatPanel.tsx
        │       ├── ToolCallCard.tsx
        │       ├── ApprovalModal.tsx
        │       ├── SessionSidebar.tsx
        │       └── InputBar.tsx
        └── vite.config.ts
```

依赖方向：

- `apps/web` → `packages/web-client`（workspace 依赖）。
- 根包 `src/server/` → 根包 `src/core`、`src/security`、`src/session`（`buildHarness` / `Harness` / `EventBus` / `SessionStore`）。不依赖前端包。
- `packages/web-client` 无依赖（只含类型与浏览器侧薄封装）。

## 5. 核心架构与数据流

### 5.1 启动流程

```
blh web [--workdir X] [--port N]
  ├─ buildHarness(workdir, cli, webAsker, skipPermissions)   // 复用现有组装，仅替换 asker
  ├─ 加载 .blh/user-rules.json 合并进 rules（见 §7）
  ├─ 建一个会话：messages = harness.newSession()
  │   └─ harness.sessionStore = SessionStore.create(workdir)  // 复用现有落盘
  ├─ startWebServer(port)：
  │   ├─ 监听 127.0.0.1:port
  │   ├─ 挂 API 路由 + SSE（node:http）
  │   └─ serve 前端静态文件（dist/web/，见 §11）
  └─ 打开浏览器 http://127.0.0.1:port
```

### 5.2 浏览器加载

```
浏览器加载 React 应用
  ├─ GET /api/session       → 当前会话状态（messages + sessionId + workdir）
  ├─ GET /api/sessions      → 历史会话列表（.sessions/*.jsonl）
  └─ EventSource /api/events → 订阅 agent 事件流
```

### 5.3 发消息与流式输出

```
用户发消息 → POST /api/message {text}
  └─ 服务器加锁（jobs.agentLock，与 REPL 一致）
       └─ harness.runTurn(messages, text, eventBus)
            └─ agentLoop 产出 AgentEvent → eventBus → SSE 推给浏览器
```

关键点：**完全复用现有 `agentLoop` 的 `events?: EventBus` 参数**。web 服务器只需像 [repl.ts](../../src/cli/repl.ts) 一样，每轮建一个 `EventBus`、`subscribe` 后把事件转发到 SSE 即可，无需改 `agentLoop`。

### 5.4 审批

```
工具需审批 → webAsker（结构化请求）→ SSE 发 approval_requested + await 一个 Promise
  └─ 浏览器弹审批卡片，用户点 允许/拒绝/总是允许
       └─ POST /api/approval {requestId, decision}
            └─ 服务器 resolve 那个 Promise → agentLoop 继续
```

## 6. HTTP / SSE API

### 6.1 SSE 事件（`GET /api/events`）

前 5 个直接复用现有 [AgentEvent](../../src/core/events.ts)（`turn_start` / `assistant_text_delta` / `tool_call` / `tool_result` / `turn_end`），新增 2 个：

| 事件 | 载荷 | 说明 |
|------|------|------|
| `turn_start` | — | 一轮开始 |
| `assistant_text_delta` | `{text}` | 流式文本增量 |
| `tool_call` | `{id, name, arguments}` | 工具调用 |
| `tool_result` | `{id, name, output, isError}` | 工具结果 |
| `turn_end` | — | 一轮结束 |
| `approval_requested` | `{requestId, tool, target, args}` | 请求审批（新增） |
| `error` | `{message}` | 错误提示（新增） |

### 6.2 HTTP 端点（浏览器 → 服务器）

| 方法 | 路径 | 请求体 | 说明 |
|------|------|--------|------|
| POST | `/api/message` | `{text}` | 发消息，启动一轮 |
| POST | `/api/approval` | `{requestId, decision}` | 回复审批，`decision ∈ allow/deny/always_allow` |
| GET | `/api/session` | — | 当前会话状态 |
| GET | `/api/sessions` | — | 历史会话列表 |
| GET | `/api/sessions/:id` | — | 查看某历史会话消息 |
| POST | `/api/session/new` | — | 新建会话（结束当前，新建 `.sessions` 文件） |
| POST | `/api/session/resume` | `{file}` | 恢复某历史会话为当前会话 |

### 6.3 多会话扩展口子

虽然当前是单会话，但**从第一天起就把 `sessionId` 写进协议**，避免未来返工：

- `GET /api/events/:sessionId`、`POST /api/message` 的响应、`GET /api/session` 的响应都带 `sessionId`。
- 服务器内部用 `SessionManager` 抽象（见 §9），当前 `list()` 恒为 1 个，未来改成多个即可，前端无需重写协议。

## 7. 审批流程（含「总是允许」）

### 7.1 泛化 `makePermissionHook`

现有 [approval.ts](../../src/security/approval.ts) 的 `AskUser` 只拿到格式化字符串 `prompt`、返回 `y/N`，无法结构化地拿到 `tool`/`target`，也不支持「总是允许」。因此把它泛化（CLI 行为不变）：

```ts
export interface ApprovalRequest {
  tool: string;
  target: string;
  args: Record<string, unknown>;
}
export type ApprovalDecision = "allow" | "deny" | "always_allow";
export type ApprovalAsker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
): PermissionHook
```

hook 内部逻辑：

1. `matchRule(rules, tool, target)` → `allow` 直接放行；`deny` 直接阻断。
2. `approvalContext.scheduledTurn` → 阻断（与现状一致）。
3. 否则 `const decision = await ask({tool, target, args})`。
4. `decision === "allow"` → 放行；`"deny"` → 阻断；`"always_allow"` → 记录规则并放行。

### 7.2 「总是允许」的规则处理

`decision === "always_allow"` 时，`makePermissionHook` 内部：

1. 构造 `rule = { tool, target, action: "allow" }`（`target` 用与匹配时相同的提取值）。
2. 把 `rule` 插入内存 `rules` —— 位置在**硬性 deny 之后、默认 ask/allow 之前**，保证「总是允许」不能覆盖 `rm -rf /*`、`git push --force*` 这类硬禁止。
3. 调用 `persistRule(rule)` 落盘（web 注入；CLI 不传，默认空操作）。

`target` 为空（工具既无 `command` 也无 `path`）时，不提供「总是允许」按钮，避免写出 `target:""` 的过宽规则。

### 7.3 规则持久化

- 文件：`.blh/user-rules.json`，数组格式 `PermissionRule[]`。
- 启动时加载，合并进规则列表（同样插在硬性 deny 之后、默认 ask/allow 之前）。
- 新增规则时 `appendFileSync` 或整体覆写该文件；`.blh/` 已在 `.gitignore` 中忽略。

### 7.4 CLI 适配

`src/cli/main.ts` 的 `makeAskUser` 改成接收结构化 `ApprovalRequest`，自己拼 `allow <tool>(<target>)? [y/N] ` 提示，返回 `"allow"` 或 `"deny"`，**对外行为与现在完全一致**。

## 8. 会话历史

复用现有 [SessionStore](../../src/session/store.ts)（`create` / `open` / `latest` / `load` / `append` 已实现）：

- **当前会话**：一个 `messages` 数组 + 一个 `SessionStore`，每条消息产生时 `append` 到 `.sessions/session_<ts>_<seq>.jsonl`（已有 `Harness`/`agentLoop` 的 append 挂载点，无需新增）。
- **历史列表**：`GET /api/sessions` 扫描 `.sessions/*.jsonl`，返回文件名 + mtime + 首条 user 消息预览。
- **查看**：`GET /api/sessions/:id` 用 `SessionStore.load` 读回消息，前端只读渲染。
- **恢复**：`POST /api/session/resume` 用 `SessionStore.open` 打开该文件，`messages = [newSession()[0], ...load(file)]`，之后继续 append 同一文件。
- **新建**：`POST /api/session/new` 结束当前会话，`SessionStore.create` 建新文件、`messages = newSession()`。

## 9. 多会话扩展口子（`SessionManager`）

为未来「多会话并发」预留接口，当前只实现单会话：

```ts
export interface SessionManager {
  create(workdir: string): SessionHandle;              // 建新会话
  resume(workdir: string, file: string): SessionHandle; // 恢复历史会话
  get(id: string): SessionHandle | undefined;
  list(): SessionHandle[];                              // 当前恒为 1 个
  runTurn(id: string, text: string): Promise<void>;     // 加锁跑一轮
  approve(requestId: string, decision: ApprovalDecision): void; // 应答审批
  dispose(id: string): Promise<void>;
}
```

`SessionHandle` 持有该会话自己的 `messages` / `EventBus` / `SessionStore` / `webAsker`（含 pending approval map）。当前 `SessionManager` 内部只有一个 handle；未来要支持多会话时，把「单一 handle」换成「Map<id, handle>」，并解决 `buildHarness` 的共享状态隔离问题（见 §14 非目标，本次不做）。

## 10. 前端组件

`apps/web` 用 React 状态（`useReducer`）管理，不引入 Redux/Zustand（YAGNI）。顶层 `App` 持有 reducer，`useAgentEvents` 订阅 SSE 把事件派发给 reducer。

| 组件 | 职责 |
|------|------|
| `App` | 整体布局 + `useReducer` 状态 + 拉取初始会话/历史 |
| `ChatPanel` | 消息列表 + 流式文本渲染 |
| `ToolCallCard` | 渲染 `tool_call` + `tool_result`：可折叠、状态图标、输出截断（超长折叠） |
| `ApprovalModal` | 渲染 `approval_requested`：显示工具/参数/target，三个按钮 |
| `SessionSidebar` | 历史会话列表：点击查看；「恢复」「新建」操作 |
| `InputBar` | 输入框 + 发送；发送后禁用直到 `turn_end` |

状态与事件：

- `assistant_text_delta` → 追加到当前 assistant 消息文本。
- `tool_call` → 插入一条「进行中」的工具卡片；`tool_result` → 用 `id` 关联补上结果与成功/失败状态。
- `approval_requested` → 打开 `ApprovalModal`，等用户点按钮后 `POST /api/approval`。
- `turn_end` → 解锁输入框。

## 11. 开发与构建

### 11.1 构建

- 根包 `build`（`tsc -p tsconfig.build.json`）编译核心 + `src/server/`。
- `apps/web` 用 Vite 构建到 `apps/web/dist`。
- **静态资源落地**：根包新增 `build:web` 脚本，构建 `apps/web` 后把 `dist` 复制到根包 `dist/web/`。`blh web` 运行时从 `dist/cli/main.js` 的相对路径 `../web` 读取前端静态文件（开发与打包都能定位，不依赖 `process.cwd()`）。

### 11.2 开发模式

- `apps/web` 跑 Vite dev server（HMR），把 `/api` 代理到 `blh web` 服务器端口；前端改代码即时热更新，无需重新构建。
- `blh web` 提供全部 API + SSE；`--dev` 时跳过静态文件服务，只留 API（由 Vite dev server 提供页面）。

### 11.3 `.gitignore`

补充 `.superpowers/`（头脑风暴产物）与 `apps/web/dist/`（构建产物）。

## 12. 测试策略

- **单元测试（vitest，现有）**：
  - `src/server/http.ts`：路由分发、SSE 响应头与事件序列化、静态文件服务。
  - `src/server/session.ts`：`SessionManager` 的 create/resume/new/list/runTurn（注入 fake Harness）。
  - `src/server/approval.ts`：审批 pending Promise 的 resolve 路径；`always_allow` 写规则 + 合并位置（不覆盖硬性 deny）。
  - `src/security/approval.ts`：泛化后的 `makePermissionHook` 三种决策分支、`persistRule` 回调。
  - `SessionStore`：已有测试保持不变。
- **e2e（Playwright）**：用 `MockProvider`（脚本化回复）+ 真实临时目录启动 `blh web`，浏览器断言：流式文本、工具调用卡片、审批弹窗三按钮、会话历史列表/查看/恢复。

## 13. 变更文件清单

- 修改 `pnpm-workspace.yaml`：加 `packages: ["packages/*", "apps/*"]`。
- 新增 `src/server/`：`index.ts` / `http.ts` / `session.ts` / `bridge.ts` / `approval.ts`。
- 修改 `src/security/approval.ts`：泛化 `makePermissionHook`（结构化 asker + `persistRule`）。
- 修改 `src/cli/main.ts`：`makeAskUser` 适配新接口；新增 `web` 子命令分支；`USAGE` 增加说明。
- 新增 `packages/web-client/`：`types.ts` / `sse.ts` / `api.ts`。
- 新增 `apps/web/`：Vite + React 前端（组件、hook、vite 配置）。
- 修改根包 `package.json`：新增 `build:web` 脚本、workspace 脚本。
- 修改 `.gitignore`：补充 `.superpowers/`、`apps/web/dist/`。
- 新增上述测试文件。

## 14. 非目标（YAGNI）

- 不引入 Cordis / 依赖注入 / 插件加载 / UI slots 体系。
- 不做多会话并发（只留接口口子；`buildHarness` 的共享状态隔离重构暂不做）。
- 不做会话消息搜索、分页、删除、重命名等完整会话管理。
- 不做远程访问 / 认证（仅 127.0.0.1）。
- 不做移动端适配、主题切换、国际化。
- 不改 `-p` 单次模式与定时/team 轮次（保持非流式，与现状一致）。
