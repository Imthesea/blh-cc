# 后端层修复计划（apps/web-server + packages/）

- 日期：2026-09-18
- 范围：后端层 `apps/web-server/`、`packages/logger/`、`packages/web-client/`
- 依据：`docs/2026-09-18-code-review.md` 二、后端层章节
- 状态：已完成

---

## 任务 1：静态文件流补错误处理（严重）

现状 `apps/web-server/src/http.ts:109-120`：`statSync` 与 `createReadStream` 之间文件可能被删，`createReadStream(file).pipe(res)` 无 `error` 监听，客户端断开也不销毁流，可能崩溃进程。

修复：给 `createReadStream` 挂 `error` 监听（未发头返回 404/500，已发头 `res.destroy()`）；`res.on("close")` 时销毁流。

- [x] **步骤 1**：补测试 `test/http.test.ts`（或新文件）——读一个存在后被删/不存在的静态文件返回 404/500 而非崩溃
- [x] **步骤 2**：修改 `serveStatic` 加 `error` 监听 + `close` 销毁
- [x] **步骤 3**：回归 `pnpm exec vitest run apps/web-server`

## 任务 2：SSE 广播背压保护（严重）

现状 `apps/web-server/src/bridge.ts:31-44`：`client.write(frame)` 忽略返回值，慢客户端导致内核缓冲无界增长。

修复：`write` 返回 `false`（背压）时删除该客户端并 `end()`，丢弃慢客户端。

- [x] **步骤 1**：补测试 `test/bridge.test.ts`——`write` 返回 `false` 时该客户端被断开移除
- [x] **步骤 2**：修改 `broadcast`
- [x] **步骤 3**：回归

## 任务 3：Host 校验防 DNS rebinding（严重）

现状 `apps/web-server/src/http.ts:261-289`：仅绑 127.0.0.1，不校验 Host/Origin，GET 端点（session/sessions/events）不校验，DNS rebinding 可读取会话内容。

修复：请求入口统一校验 `Host` 头的 hostname 必须是 `127.0.0.1`/`localhost`/`[::1]`，否则 403。覆盖所有路由（含 static 与 `/api/events`）。

- [x] **步骤 1**：补测试 `test/http.test.ts`——伪造 `Host: evil.com` 返回 403，合法 host 正常
- [x] **步骤 2**：实现 `isLocalHost` + 入口校验
- [x] **步骤 3**：回归

## 任务 4：请求体大小上限（严重）

现状 `apps/web-server/src/http.ts:57-75`：`readBody` 无条件累积，无 Content-Length 检查，可 OOM。

修复：设 `MAX_BODY_BYTES`（1MB），`Content-Length` 超限直接 413；流式累积超限时 413 并 `req.destroy()`。

- [x] **步骤 1**：补测试——超大 `Content-Length` 返回 413，chunked 超限返回 413
- [x] **步骤 2**：修改 `readBody`
- [x] **步骤 3**：回归

## 任务 5：可优化点（低风险）

- [x] **步骤 1**：`/api/sessions/:file` 的 `load` 包 try/catch，ENOENT 返回 404 而非 500（`http.ts:162-165`）
- [x] **步骤 2**：`serveStatic` 对 pathname 做 URL 解码后再 normalize 校验，修复含空格/中文文件名 404（`http.ts:110-112`）
- [x] **步骤 3**：外层 catch 检查 `res.headersSent`，已发头则 `res.destroy()` 而非二次 writeHead（`http.ts:282-288`）
- [x] **步骤 4**：`EventBus.emit` 异常记 `log.warn` 而非静默吞（`events.ts:20-22`）
- [x] **步骤 5**：`/api/log` 字段大小校验（message 上限、fields 序列化上限），防写爆磁盘（`http.ts:192-221`）
- [x] **步骤 6**：`appendRawEntry` 走级别过滤，前端不能绕过级别写 debug 噪声（`packages/logger/src/node.ts:40-42`）
- [x] **步骤 7**：`isLogLevel`（`http.ts:30-32`）与 `parseLevel`（`node.ts:12-17`）去重，抽到 `@blh/logger` 导出

## 任务 6：日志系统问题

- [x] **步骤 1**：终端格式加毫秒（`format.ts:14-16` 的 `terminalTime` 补 `.SSS`）
- [x] **步骤 2**：字段值含空格时加引号，保证可解析（`format.ts:30-38` 的 `formatFields`）
- [x] **步骤 3**：`appendFileSync` 改异步 `appendFile`，避免阻塞事件循环（`node.ts:30-38`）

## 任务 7：测试缺口

- [x] **步骤 1**：审批超时自动拒绝（`test/approval.test.ts` + fake timers）
- [x] **步骤 2**：`serveStatic` 路径穿越/404/内容类型（新 `test/static.test.ts`）
- [x] **步骤 3**：`/api/sessions/:file` 成功路径 + ENOENT 404（`test/http.test.ts`）
- [x] **步骤 4**：`EventBus.emit` 监听器抛异常不中断其它监听器（新 `test/events.test.ts`）
- [x] **步骤 5**：`packages/web-client` 补 vitest 配置 + `sse.ts`/`api.ts` 基础测试

## 任务 8：收尾验证

- [x] **步骤 1**：`pnpm typecheck` PASS
- [x] **步骤 2**：`pnpm lint` PASS
- [x] **步骤 3**：`pnpm test` 全绿（新增用例 + 既有 380 通过）

---

## 范围外（架构级/重构，本次不做）

- 抽 `@blh/shared` 共享类型包（消除 `AgentEvent`/`WebEvent`/`ApprovalDecision`/`ChatMessage` 前后端重复）
- `http.ts` 按资源拆分（约 290 行职责过重）
- 硬编码端口/地址/审批超时/`.blh` 目录名集中
- 日志关联 ID（trace/correlation）贯穿 HTTP → runTurn → SSE
- 日志日期口径统一（文件名本地 vs 内容 UTC 属合理取舍，暂不强制改）
- `dispose`/多会话句柄管理（当前单会话，`dispose` 无 HTTP 入口属未来多会话扩展）
- `EVENT_TYPES` 与 `WebEvent` 类型重复（依赖 `@blh/shared`，一并延后）
- `sse.ts` 类型断言收紧 + onmessage 兜底（依赖 `@blh/shared` 类型）
