# Agent 层修复 实现计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用复选框（`- [ ]`）跟踪进度。严格遵循 TDD：每个修复先写失败测试、观察其失败，再写最小实现。

**目标：** 修复 agent 核心层（`src/`）检视报告中发现的全部严重问题（1–10）与可优化点，并补齐测试缺口。只改 agent 层，不碰 `apps/web`、`apps/web-server`、`packages/`。

**依据：** `docs/2026-09-18-code-review.md`（agent 核心层章节）

**技术栈：** TypeScript 5.x、Node `node:child_process`、`node:async_hooks`、`node:fs`、vitest。

---

## 严重问题与修复方案速览

| # | 问题 | 修复方案 | 涉及文件 |
|---|---|---|---|
| 1 | skip-permissions 危险命令可绕过 | 新增破坏性命令检测，在权限钩子层硬拦截 | rules.ts、approval.ts |
| 2 | bash 超时定时器未清理/未 unref | 保存 timer 引用，settled 时 clearTimeout + unref | bash.ts、background.ts |
| 3 | Unix 超时只杀 shell 不杀进程组 | `detached:true` + `process.kill(-pid)` | bash.ts、background.ts |
| 4 | approvalContext 全局标志竞态 | 改用 `AsyncLocalStorage` | approval.ts、harness.ts、teammate.ts |
| 5 | MCP 连接失败工具不回收 | registry 增加 `unregister`，connect 失败回滚 | registry.ts、mcp.ts |
| 6 | MCP 子进程无 error/exit 监听 | 补 error/exit 监听并 reject pending | mcp.ts |
| 7 | Hook 异常不隔离 | trigger/firstBlock 捕获异常记 warn | hooks.ts |
| 8 | leadTick 无异常捕获 | 补 try/catch | team.ts |
| 9 | 文件工具 symlink 逃逸 | safePath 用 realpath 校验 | files.ts |
| 10 | -p 非交互静默 deny | 无 asker 时返回明确提示 | approval.ts、main.ts |

---

## 任务 1：破坏性命令硬拦截（严重问题 1）

**需求（用户明确）：** `--dangerously-skip-permissions` 下，不允许 `rm -rf` 这类破坏性命令通过，但普通 bash 命令、修改文件命令照常运行。

**现状：** `DEFAULT_RULES` 只 deny `git push --force*`、`rm -rf /*`，靠 `fnmatch` 子串匹配，`rm -rf /`、`rm -rf --no-preserve-root /`、`git push -f`、`git push origin +main`、`find / -delete` 都能绕过。

**方案：** 在 `src/security/rules.ts` 新增 `isDestructiveBashCommand(command)`，用正则数组检测高危操作；在 `src/security/approval.ts` 的 `makePermissionHook` 里，对 `tool === "bash"` 的命令先做破坏性检测，命中即返回 deny，不经过 `matchRule`（因此 skip-permissions 也无法绕过）。

**文件：** `src/security/rules.ts`、`src/security/approval.ts`
**测试：** `test/security/rules.test.ts`、`test/security/approval.test.ts`

- [x] **步骤 1（TDD RED）：写破坏性命令检测测试**

在 `test/security/rules.test.ts` 新增 `isDestructiveBashCommand` 用例，覆盖至少这些绕过变体（期望 `true`）：

- `rm -rf /`、`rm -rf /*`、`rm -rf --no-preserve-root /`
- `rm -rf ~`、`rm -rf /home`、`rm -rf /etc /var`
- `git push -f origin main`、`git push --force`、`git push --force-with-lease origin main`、`git push origin +main`
- `find / -delete`、`find / -exec rm -rf {} \;`
- `mkfs.ext4 /dev/sda1`、`dd if=/dev/zero of=/dev/sda`

正常命令（期望 `false`）：`ls -la`、`rm -rf node_modules`、`rm dist`、`npm install`、`git push origin main`、`git commit -m x`。

运行 `pnpm exec vitest run test/security/rules.test.ts`，确认新用例失败（函数不存在）。

- [x] **步骤 2（GREEN）：实现 `isDestructiveBashCommand`**

在 `rules.ts` 实现正则数组检测，覆盖步骤 1 全部变体。注意 `rm` 需同时含递归/强制标志与根级/家目录/系统目录目标，避免误伤 `rm -rf node_modules`。

- [x] **步骤 3（TDD RED）：在权限钩子层硬拦截**

在 `test/security/approval.test.ts` 新增：`makePermissionHook(SKIP_PERMISSIONS_RULES, asker)` 下 `hook("bash", { command: "rm -rf /" })` 返回 deny 文案且不调用 asker；`hook("bash", { command: "ls" })` 返回 null；`hook("bash", { command: "git push -f" })` 返回 deny。

- [x] **步骤 4（GREEN）：在 `makePermissionHook` 接入检测**

`makePermissionHook` 内，取到 target 后：若 `tool === "bash"` 且 `isDestructiveBashCommand(target)`，记 warn 并返回 `denied by permission rule (bash: <target>)`，早于 `matchRule`。

- [x] **步骤 5：回归**

运行 `pnpm exec vitest run test/security`，全部通过。

---

## 任务 2：bash 定时器清理 + unref（严重问题 2）

**现状：** `src/tools/bash.ts` 第 43–49 行 `setTimeout` 从不清理、不 `unref`，命令正常结束后定时器最长残留 120s，`-p` 模式进程滞留。

**文件：** `src/tools/bash.ts`
**测试：** `test/tools/bash.test.ts`

- [x] **步骤 1（TDD RED）：写「定时器被清理」测试**

用 `vi.useFakeTimers()` + `vi.getTimerCount()`，或 spy `setTimeout` 返回值的 `unref`/`clearTimeout`。更简单可靠的方案：spy 全局 `setTimeout` 捕获返回的 Timeout 对象，`runBash` resolve 后断言该 timer 的 `clearTimeout` 被调用过。若难以观测，至少断言：命令正常完成后 `vi.getTimerCount() === 0`。

- [x] **步骤 2（GREEN）：保存 timer 引用**

在 `runBash` 内声明 `let timer: NodeJS.Timeout | undefined`；`execFile` 回调 `settled = true` 后 `clearTimeout(timer)`；`setTimeout` 赋值给 `timer` 并调用 `timer.unref()`。

- [x] **步骤 3：回归** `pnpm exec vitest run test/tools/bash.test.ts`

---

## 任务 3：Unix 超时杀进程组（严重问题 3）

**现状：** `src/tools/bash.ts` 的 `killTree` 在非 Windows 只 `child.kill("SIGKILL")`，`sh -c` 的子进程（如 `sleep 999`）变孤儿。`src/jobs/background.ts` 同样问题。

**文件：** `src/tools/bash.ts`、`src/jobs/background.ts`
**测试：** `test/tools/bash.test.ts`（新增）

- [x] **步骤 1（TDD RED）：写「超时后子进程被杀」测试**

非 Windows 平台：起 `node -e "setTimeout(()=>{}, 30000)"` 的 bash 命令，1s 超时后，用 `ps`/`process.kill(pid, 0)` 探测派生进程已不存在。Windows 平台跳过（`it.skipIf(process.platform === "win32")`）。

- [x] **步骤 2（GREEN）：detached + 进程组 kill**

`execFile` 选项加 `detached: process.platform !== "win32"`；`killTree` 非 Windows 分支改 `try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }`。`background.ts` 同步修改。

- [x] **步骤 3：回归** `pnpm exec vitest run test/tools/bash.test.ts test/jobs/background.test.ts`

---

## 任务 4：approvalContext 改用 AsyncLocalStorage（严重问题 4）

**现状：** `src/security/approval.ts:24` 的 `approvalContext = { scheduledTurn: false }` 是进程级可变单例，`harness.ts` 与 `teammate.ts` 无锁共享，teammate 的 finally 恢复会覆盖主循环标志，导致计划任务误弹交互审批。

**方案：** 用 `node:async_hooks` 的 `AsyncLocalStorage<boolean>` 承载 scheduled-turn 上下文，随异步调用链传播，天然隔离并发。

**文件：** `src/security/approval.ts`、`src/core/harness.ts`、`src/agents/teammate.ts`
**测试：** `test/security/approval.test.ts`、`test/core/harness.test.ts`（如需）

- [x] **步骤 1（TDD RED）：改测试为 AsyncLocalStorage 语义**

`test/security/approval.test.ts` 的「scheduled turn 内拒绝交互审批」用例改为：用新导出的 `runInScheduledTurn(async () => hook("bash", {command:"ls"}))` 包裹，断言返回 deny 文案且 asker 未调用；同时新增「scheduled-turn 上下文外不受影响」用例。

- [x] **步骤 2（GREEN）：实现 AsyncLocalStorage**

`approval.ts` 删除 `approvalContext` 导出，新增：

```ts
const scheduledTurnStorage = new AsyncLocalStorage<boolean>();
export function runInScheduledTurn<T>(fn: () => Promise<T>): Promise<T> {
  return scheduledTurnStorage.run(true, fn);
}
```

`makePermissionHook` 内把 `if (approvalContext.scheduledTurn)` 改为 `if (scheduledTurnStorage.getStore() === true)`。

- [x] **步骤 3：改调用点**

`src/core/harness.ts`：`runScheduledTurn` 与 `runTeamTurn` 里，把 `approvalContext.scheduledTurn = true; try { ... } finally { approvalContext.scheduledTurn = false }` 改为 `await runInScheduledTurn(() => agentLoop(...))`（并保留 cron 回滚的 try/catch）。

`src/agents/teammate.ts`：`runTool` 里把「读旧值→置 true→finally 恢复」改为用 `runInScheduledTurn` 包裹 `firstBlock + dispatch + trigger`。

- [x] **步骤 4：回归** `pnpm exec vitest run test/security test/core/harness.test.ts test/agents`

---

## 任务 5：MCP 连接失败回滚（严重问题 5）

**现状：** `src/extensions/mcp.ts` 的 `MCPRegistry.connect` 在 for 循环逐个 register，中途 return 错误时已注册的 `mcp__*` 工具与 `origins` 条目不回滚。

**文件：** `src/tools/registry.ts`、`src/extensions/mcp.ts`
**测试：** `test/extensions/mcp.test.ts`

- [x] **步骤 1（TDD RED）：写回滚测试**

构造一个 MCP server 返回多个工具，其中第二个工具名超长（触发 64 字符错误）。断言 `connect` 返回错误后，`registry.list()` 不含任何 `mcp__*` 工具。

- [x] **步骤 2（GREEN）：registry 增加 unregister + connect 回滚**

`ToolRegistry` 增加 `unregister(name: string): void`（`this.tools.delete(name)`）。

`connect` 里把 `registered` 收集起来，在 `return Error` 分支与 catch 分支回滚：`for (const name of registered) { this.registry.unregister(name); this.origins.delete(name); }`。

- [x] **步骤 3：回归** `pnpm exec vitest run test/extensions/mcp.test.ts`

---

## 任务 6：MCP 子进程 error/exit 监听（严重问题 6）

**现状：** `src/extensions/mcp.ts` 的 `MCPClient.start` spawn 后只挂 stdout readline，命令不存在时 unhandled `error` 崩溃；进程退出后 pending 请求只能等 30s 超时。

**文件：** `src/extensions/mcp.ts`
**测试：** `test/extensions/mcp.test.ts`

- [x] **步骤 1（TDD RED）：写 error/exit 测试**

用例 1：`new MCPClient("x", "definitely-not-a-real-cmd-xyz")` 调 `start()` 应 reject（而非 unhandled error）。用例 2：启动一个「立即退出」的 server（`node -e "process.exit(1)"`），`start()` 应 reject 或后续 `request` 应 reject，而不是卡到 30s。

- [x] **步骤 2（GREEN）：挂 error/exit 监听**

`start()` 内：`this.process.on("error", (err) => this.failPending(err))`；`this.process.on("exit", (code) => this.failPending(new Error(...)))`。实现 `failPending`：遍历 `pending`，逐个 reject，清空 map。注意 `start` 自身 `initialize` 的 request 也会被 reject，直接抛出即可。

- [x] **步骤 3：回归** `pnpm exec vitest run test/extensions/mcp.test.ts`

---

## 任务 7：Hook 异常隔离（严重问题 7）

**现状：** `src/core/hooks.ts` 的 `trigger`/`firstBlock` 直接 `await fn(...)`，单个 hook 抛错会中断整轮并丢结果。

**文件：** `src/core/hooks.ts`
**测试：** `test/core/hooks.test.ts`

- [x] **步骤 1（TDD RED）：写异常隔离测试**

`trigger` 注册两个 hook，第一个抛错、第二个返回 `"ok"`，断言 `trigger` 返回 `[null, "ok"]`（抛错的记 null，不中断）；`firstBlock` 第一个抛错、第二个返回 `"denied"`，断言返回 `"denied"`。

- [x] **步骤 2（GREEN）：捕获异常记 warn**

`trigger`：`try { results.push(await fn(payload)) } catch (e) { log.warn("hook error", {event, error}); results.push(null) }`。`firstBlock`：同样 try/catch，抛错的跳过。

- [x] **步骤 3：回归** `pnpm exec vitest run test/core/hooks.test.ts`

---

## 任务 8：leadTick 异常捕获（严重问题 8）

**现状：** `src/agents/team.ts:84-92` 的 `leadTick` 只有 try/finally，`teamTurn()` 抛错成 unhandled rejection。

**文件：** `src/agents/team.ts`
**测试：** `test/agents/team.test.ts`（新增）

- [x] **步骤 1（TDD RED）：写异常捕获测试**

构造 TeamRuntime（或最小 mock），`setTeamTurn` 一个会 throw 的 callback，调用 `leadTick`（或触发 start 的 timer）后不产生 unhandled rejection、且锁被 release。可 spy `agentLock.release` 断言被调用。

- [x] **步骤 2（GREEN）：补 catch 记 warn**

`leadTick` 加 `catch (error) { log.warn("lead tick failed", { error: ... }) }`，保留 finally 释放锁。需给 `team.ts` 加 `createLogger`。

- [x] **步骤 3：回归** `pnpm exec vitest run test/agents/team.test.ts`

---

## 任务 9：文件工具 symlink 逃逸（严重问题 9）

**现状：** `src/tools/files.ts` 的 `safePath` 只做词法 `path.resolve` 前缀判断，workdir 内指向外部的 symlink 可被跟随读写。

**文件：** `src/tools/files.ts`
**测试：** `test/tools/files.test.ts`

- [x] **步骤 1（TDD RED）：写 symlink 逃逸测试**

POSIX 平台（`it.skipIf(process.platform === "win32")`）：在 tmp workdir 外建 `secret.txt`，workdir 内建 symlink `link -> 外部目录`，断言 `readFile(dir, { path: "link/secret.txt" })` reject `PathEscapeError`；`writeFile(dir, { path: "link/new.txt" })` reject。

- [x] **步骤 2（GREEN）：realpath 校验**

新增辅助：`async function assertInside(workdir, resolved)`，用 `fs.realpath` 比较真实路径。readFile/editFile：`const real = await fs.realpath(filePath)`，与 `realRoot = await fs.realpath(workdir)` 做前缀校验。writeFile：先 `mkdir` 父目录，再对父目录 `realpath` 校验。保留现有词法 `safePath`（防 `../`），再加 realpath 层。

- [x] **步骤 3：回归** `pnpm exec vitest run test/tools/files.test.ts`

---

## 任务 10：-p 非交互静默 deny 提示（严重问题 10）

**现状：** `src/security/approval.ts:31` 无 asker 时默认 `async () => "deny"`，`-p` 模式任何 ask 类 bash 命令静默被拒。

**文件：** `src/security/approval.ts`
**测试：** `test/security/approval.test.ts`

- [x] **步骤 1（TDD RED）：写无 asker 提示测试**

`makePermissionHook(DEFAULT_RULES, undefined)`（不传 asker），`hook("bash", { command: "ls" })` 返回包含「non-interactive」或「skip permissions」提示的文案（不再是笼统 `denied by user`）。

- [x] **步骤 2（GREEN）：无 asker 返回明确提示**

`asker` 缺省时，若匹配到 `ask`，返回 `denied: no approval asker available (non-interactive mode); use --dangerously-skip-permissions to allow non-destructive bash`。

- [x] **步骤 3：回归** `pnpm exec vitest run test/security/approval.test.ts`

---

## 任务 11：可优化点

**文件：** 见各步骤。**测试：** 对应 test 文件。

- [x] **步骤 1：`isError` 判定收紧**（`src/core/loop.ts:144`）

现状 `result.startsWith("error:")` 会把以 `error:` 开头的合法输出误判、且 deny 文案不判错。改为：`isError = result.startsWith("error:") || result.startsWith("denied")`。测试 `test/core/loop.test.ts` 补一条。

- [x] **步骤 2：`isPromptTooLong` 识别 413/422**（`src/providers/openai.ts:229-234`）

把 `error.status !== 400` 改为接受 `400 | 413 | 422`。测试 `test/providers/openai.test.ts` 补 413 用例。

- [x] **步骤 3：`read_file` 文件大小上限**（`src/tools/files.ts:33`）

读取前 `statSync(filePath).size`，超过阈值（如 10MB）返回明确错误而非整读。测试补超大文件用例。

- [x] **步骤 4：`toInt` 拒绝负数**（`src/core/config.ts:60-67`）

`bash_timeout`/`max_output_chars` 为负时抛 `ConfigError`。测试 `test/core/config.test.ts` 补负数用例。

- [x] **步骤 5：`fnmatch` 转义 `[`/`]`**（`src/tools/glob.ts:6-18`）

未闭合 `[` 会构造非法正则抛错。把字符类替换后，对残留的裸 `[`/`]` 做转义兜底。测试 `test/tools/glob.test.ts` 补 `pattern="foo[abc"` 不抛错。

- [x] **步骤 6：抽取重复 `parseArgs`**（`core/loop.ts`、`agents/subagent.ts`、`agents/teammate.ts` 三份）

在 `core/loop.ts` 已导出的 `parseToolArguments` 基础上，让 subagent/teammate 复用（或抽到公共模块）。测试回归 `test/core/loop.test.ts test/agents`。

- [x] **步骤 7：回归全量 agent 测试**

运行 `pnpm exec vitest run test`，全部通过。

---

## 任务 12：收尾验证

- [x] **步骤 1：typecheck**

运行 `pnpm typecheck`，预期 PASS。

- [x] **步骤 2：lint**

运行 `pnpm lint`，预期 PASS。

- [x] **步骤 3：全量测试**

运行 `pnpm test`，预期 380 通过 + 新增用例全绿，无失败。

---

## 范围外（本次不处理）

以下检视建议属架构级/性能级或超出 agent 层，本次不做，留待后续单独评估：

- 流式重试只覆盖 create 阶段（涉及 provider 架构，风险高）
- `ContextCompactor.prepare` 重复 `JSON.stringify`、`runTurn` 额外模型调用、`SessionStore` 同步写盘（性能优化，需基准验证）
- `runBash` 与 `background.ts` 的 `runBashProcess` 合并去重（重构面广，行为需谨慎对齐）
- 魔数集中到常量（可维护性，非 bug）
- 后端层与前端层问题（`apps/web-server`、`apps/web`、`packages/`）—— 按用户指示，后续另行处理
