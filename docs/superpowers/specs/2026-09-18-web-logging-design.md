# Web 日志系统设计

- 日期：2026-09-18
- 状态：待审查

## 1. 背景与目标

根包已有一套自研日志系统（`src/core/logger.ts`，2026-09-16 实现），但它是纯 Node 实现（`node:fs` 写文件 + `process.stderr`），且只覆盖根包 `src/` 下的模块。本次要覆盖的三端目前零日志：

| 目标 | 类型 | 现状 |
|------|------|------|
| `apps/web-server` | Node 独立包 | 无日志，且不能反向 import 根包 |
| `apps/web` | React 浏览器前端 | 无日志，无文件系统 |
| `packages/web-client` | 浏览器客户端库 | 无日志，无文件系统 |

目标：把日志能力统一扩展到这三端，目的只有一个——方便找 bug。浏览器端日志需回传后端落盘，否则用户关掉 DevTools 后日志即丢失，无法事后定位。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 日志实现复用 | 抽共享包 `@blh/logger`，根包与 web-server 共用，前端复用格式化 |
| 浏览器端日志去向 | `console`（DevTools 实时）+ 回传 web-server 落盘 |
| 前端日志落盘位置 | 与 server 日志写同一个 `.blh/logs/blh-YYYY-MM-DD.log`，靠 `module` 字段区分来源 |
| 前端日志回传方式 | 复用 `@blh/web-client` 的 `request()`（自动带 `x-blh-web` 头），POST `/api/log` |

## 3. 架构

### 3.1 新增共享包 `@blh/logger`（`packages/logger`）

把根包 `src/core/logger.ts` 抽取为独立 workspace 包，一套接口同时服务 Node 与浏览器：

```
packages/logger/
  src/types.ts      # LogLevel / Logger / LogFields / LogEntry / LogSink
  src/format.ts     # formatTerminal / formatFile（纯函数，零 node 依赖）
  src/node.ts       # Node 版：写 stderr + 文件，initLogger / resetLogger
  src/browser.ts    # 浏览器版：写 console + 可选 remote transport
  test/logger.test.ts
  package.json / tsconfig.json / vitest.config.ts
```

- `Logger` 接口保持不变（`debug/info/warn/error/child`），根包现有调用方只改 import 路径，不改调用逻辑。
- 通过 `package.json` 的 `exports` 条件导出区分环境：`node` 条件给根包与 web-server，`browser` 条件给前端。Vite 打包时自动选 `browser`，NodeNext 自动选 `node`。
- Node 版输出与现有实现一致：终端 `[HH:MM:SS] [level] [module] message key=value` 写 stderr，文件写 JSON 行。
- 浏览器版输出：`console` 按级别映射（`debug`/`info`/`warn`/`error`），并支持注册一个全局 `remote transport`（`(entry: LogEntry) => void`），注册后每条日志额外转发给该回调用于回传。

### 3.2 根包迁移（消除重复实现）

- 删除 `src/core/logger.ts`。
- 根包内所有 `import ... "../core/logger.js"` / `"./logger.js"` 改为 `@blh/logger`（涉及 `cli/main.ts`、`cli/harness.ts`、`core/*`、`providers/*`、`security/*`、`jobs/*`、`memory/*`、`compaction/*` 等）。
- `test/core/logger.test.ts` 随实现迁至 `packages/logger/test/`。

### 3.3 `apps/web-server` 接入 + 接收前端日志

- 依赖 `@blh/logger`，在 `startWebServer` 内调用 `initLogger(workdir)` 初始化落盘目录。
- 各模块打日志：

| 模块 | 打什么 | 级别 |
|------|--------|------|
| `web-server.index` | 启动 / 关闭 / 监听端口 | info |
| `web-server.http` | 请求方法+路径、4xx/5xx、body 解析失败、前端日志接收 | info / warn |
| `web-server.session` | create / resume / runTurn 开始与结束 | debug / info |
| `web-server.approval` | ask 挂起、resolve 应答、超时拒绝 | debug / warn |

- **新增端点 `POST /api/log`**：接收前端回传的日志数组，逐条追加写入 `.blh/logs/blh-YYYY-MM-DD.log`。沿用现有 CSRF 守卫（非 GET 请求校验 `x-blh-web: 1`，否则 403）。body 非法返回 400，成功返回 202。

### 3.4 `packages/web-client` 接入

- 依赖 `@blh/logger`（browser 版），给 `api.ts`（fetch 失败）和 `sse.ts`（连接 / SSE 载荷解析失败 / 关闭）打日志。
- 新增 `reportLogs(entries: LogEntry[]): Promise<void>`：用 `fetch` POST `/api/log`（带 `x-blh-web: 1` 头），忽略响应体。回传失败静默降级，不抛错、不触发新的远程日志（避免死循环）。

### 3.5 `apps/web` 接入

- 依赖 `@blh/logger` + `@blh/web-client`。
- 在 `main.tsx` 启动时注册 remote transport：`setRemoteTransport((entry) => void reportLogs([entry]))`。
- 在 `useAgentEvents`（SSE 连接、turn 流转、审批、错误）与 `App.tsx` 打日志。

## 4. 数据流（前端日志回传）

```
前端 logger.info("xx")
   ├─ console 输出（DevTools 实时看）
   └─ remote transport → reportLogs() → POST /api/log（x-blh-web: 1）
        └─ web-server 落盘 .blh/logs/blh-YYYY-MM-DD.log
```

一条日志在文件里的 `module` 字段区分来源：`web.app`、`web-client.api`、`web-client.sse`、`web-server.http` 等，与后端日志按时间顺序混排在同一个文件，便于看完整前后端交互时序。

## 5. 测试策略

- `packages/logger/test/logger.test.ts`：
  - `formatTerminal` / `formatFile` 纯函数输出。
  - Node 版：级别过滤、child 前缀、error 堆栈、写文件、按天滚动。
  - 浏览器版：mock `console` 断言级别映射；`setRemoteTransport` 后条目被转发。
- `apps/web-server/test/log.test.ts`：`POST /api/log` 落盘、缺失 CSRF 头 403、非法 body 400、成功 202。
- `packages/web-client`：`reportLogs` 请求封装测试。
- 全量回归：`@blh/logger` / `@blh/web-server` / 根包 test + typecheck + build，前端 `@blh/web` typecheck + build。

## 6. 非目标（YAGNI）

- 不做日志远程上报到第三方 / 集中收集平台。
- 不做日志压缩、归档、按大小滚动（仅按天滚动，沿用现有实现）。
- 不做前端日志节流/批量队列（单条回传即可，量小；后续需要再加）。
- 不引入第三方日志库。
- 不改变现有 `Logger` 接口与日志级别语义。
