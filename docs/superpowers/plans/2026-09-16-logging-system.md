# 日志系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 blh-claude-code-ts 建立统一、可分级、可持久化的日志系统（终端 + 文件双输出）。

**架构：** 自研轻量 logger（`src/core/logger.ts`），终端写 stderr（人类可读），文件写 `.blh/logs/blh-YYYY-MM-DD.log`（JSON 行）。四级日志 `debug/info/warn/error`，默认 `info`，`BLH_LOG_LEVEL` 控制。接入 provider / retry / loop / hooks / approval / config / jobs / memory / compaction。

**技术栈：** TypeScript 5.x、Node 内置 `node:fs` / `node:path`、vitest。

**规格：** `docs/superpowers/specs/2026-09-16-logging-system-design.md`

---

## 文件结构

- 创建 `src/core/logger.ts` — 核心 logger（LogLevel、Logger 接口、initLogger、createLogger、格式化纯函数）。
- 创建 `test/core/logger.test.ts` — logger 单元测试。
- 修改 `src/cli/main.ts` — initLogger 集成 + 启动/崩溃日志 + 移除 compactor notify。
- 修改 `src/providers/openai.ts` — 请求/响应日志。
- 修改 `src/providers/retry.ts` — 重试日志。
- 修改 `src/core/loop.ts` — 每轮/工具调用日志。
- 修改 `src/core/hooks.ts` — hook 触发日志。
- 修改 `src/security/approval.ts` — deny/ask 日志。
- 修改 `src/core/config.ts` — 配置来源/apiKey 日志。
- 修改 `src/jobs/runtime.ts`、`src/jobs/cron.ts`、`src/memory/extract.ts`、`src/compaction/compactor.ts` — 迁移现有 `console.log`。

---

## 任务 1：logger 核心模块

**文件：**
- 创建：`src/core/logger.ts`
- 测试：`test/core/logger.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// test/core/logger.test.ts
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  formatFile,
  formatTerminal,
  initLogger,
  resetLogger,
} from "../../src/core/logger.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "logger-"));
  resetLogger();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetLogger();
  vi.restoreAllMocks();
});

describe("formatTerminal", () => {
  it("renders time, level, module, message, fields", () => {
    const line = formatTerminal({
      time: new Date("2026-09-16T08:03:22.000Z"),
      level: "info",
      module: "providers.openai",
      message: "chat request",
      fields: { model: "gpt-4o-mini", tools: 5 },
    });
    expect(line).toContain("[info]");
    expect(line).toContain("[providers.openai]");
    expect(line).toContain("chat request");
    expect(line).toContain("model=gpt-4o-mini");
    expect(line).toContain("tools=5");
  });
});

describe("formatFile", () => {
  it("renders a single JSON line", () => {
    const line = formatFile({
      time: new Date("2026-09-16T08:03:22.000Z"),
      level: "info",
      module: "core.loop",
      message: "turn",
      fields: {},
    });
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("core.loop");
    expect(parsed.msg).toBe("turn");
    expect(parsed.time).toBe("2026-09-16T08:03:22.000Z");
  });
});

describe("createLogger", () => {
  it("writes to file after initLogger", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("providers.openai");
    log.info("chat request", { model: "m" });
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-16.log");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("chat request");
  });

  it("does not write file before initLogger", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    log.info("hello");
    expect(write).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, ".blh", "logs"))).toBe(false);
  });

  it("filters debug at default info level", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.debug("hidden");
    log.info("shown");
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-16.log");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("shown");
    expect(content).not.toContain("hidden");
  });

  it("child appends name with a dot", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("core").child("loop");
    log.info("turn");
    expect(write.mock.calls[0]?.[0]).toContain("[core.loop]");
  });

  it("error attaches stack and message", () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    const err = new Error("boom");
    log.error("failed", {}, err);
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-16.log");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("failed: boom");
    expect(content).toContain("stack");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm vitest run test/core/logger.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/core/logger.js'`。

- [ ] **步骤 3：编写 logger 实现**

```ts
// src/core/logger.ts
import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
  child(name: string): Logger;
}

export interface LogEntry {
  time: Date;
  level: LogLevel;
  module: string;
  message: string;
  fields: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";
let logDir: string | null = null;

function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

export function initLogger(workdir: string, level?: LogLevel): void {
  currentLevel = level ?? parseLevel(process.env.BLH_LOG_LEVEL);
  logDir = path.join(workdir, ".blh", "logs");
  mkdirSync(logDir, { recursive: true });
}

/** 仅供测试重置模块级状态 */
export function resetLogger(): void {
  currentLevel = "info";
  logDir = null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function terminalTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const text =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join(" ");
}

export function formatTerminal(entry: LogEntry): string {
  const suffix = formatFields(entry.fields);
  return `[${terminalTime(entry.time)}] [${entry.level}] [${entry.module}] ${entry.message}` +
    (suffix ? ` ${suffix}` : "");
}

export function formatFile(entry: LogEntry): string {
  return (
    JSON.stringify({
      time: entry.time.toISOString(),
      level: entry.level,
      module: entry.module,
      msg: entry.message,
      fields: entry.fields,
    }) + "\n"
  );
}

class LoggerImpl implements Logger {
  constructor(private readonly name: string) {}

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
    const entry: LogEntry = {
      time: new Date(),
      level,
      module: this.name,
      message,
      fields,
    };
    process.stderr.write(formatTerminal(entry) + "\n");
    if (logDir !== null) {
      const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
      appendFileSync(filePath, formatFile(entry), "utf8");
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields ?? {});
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields ?? {});
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields ?? {});
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    const merged: LogFields = { ...(fields ?? {}) };
    let finalMessage = message;
    if (error !== undefined) {
      if (error instanceof Error) {
        finalMessage = `${message}: ${error.message}`;
        if (error.stack !== undefined) merged.stack = error.stack;
      } else {
        finalMessage = `${message}: ${String(error)}`;
      }
    }
    this.write("error", finalMessage, merged);
  }

  child(name: string): Logger {
    return new LoggerImpl(`${this.name}.${name}`);
  }
}

export function createLogger(name: string): Logger {
  return new LoggerImpl(name);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm vitest run test/core/logger.test.ts`
预期：PASS（8 tests）。

- [ ] **步骤 5：Commit**

```bash
git add src/core/logger.ts test/core/logger.test.ts
git commit -m "feat(logger): add leveled terminal+file logger"
```

---

## 任务 2：CLI 启动集成

**文件：**
- 修改：`src/cli/main.ts`

- [ ] **步骤 1：initLogger 集成到 main**

在 [main.ts](f:/allProject/myProject/blh-claude-code-ts/src/cli/main.ts) 顶部新增 import，并在 `buildHarness` 内、`loadConfig` 之后调用 `initLogger`：

```ts
import { createLogger, initLogger } from "../core/logger.js";

export const log = createLogger("cli");
```

修改 `buildHarness`：

```ts
export function buildHarness(
  workdir?: string,
  cli?: Record<string, unknown>,
  askUser?: (prompt: string) => Promise<string>,
): Harness {
  const config = loadConfig(workdir, cli);
  initLogger(config.workdir);
  // ... 其余不变
}
```

- [ ] **步骤 2：compactor notify 迁移到 logger**

删除 [main.ts](f:/allProject/myProject/blh-claude-code-ts/src/cli/main.ts#L126-L131) 里的 `notify: (message) => console.log(message)` 一行：

```ts
  const compactor = new ContextCompactor({
    provider,
    transcriptDir: path.join(config.workdir, ".transcripts"),
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
  });
```

- [ ] **步骤 3：启动与崩溃日志**

在 `main()` 中启动路径加 info 日志，在 `main().catch` 加 error 日志：

```ts
async function main(): Promise<void> {
  const { prompt, workdir, cli, help } = parseCliArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  if (prompt !== undefined) {
    if (!prompt) {
      log.error("usage: blh -p <text>");
      process.exit(1);
    }
    const harness = buildHarness(workdir, cli);
    log.info("start", { workdir: harness.config.workdir, model: harness.config.model });
    const messages = harness.newSession();
    await harness.runTurn(messages, prompt);
    console.log(lastAssistantText(messages));
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const harness = buildHarness(workdir, cli, makeAskUser(rl));
  log.info("start repl", { workdir: harness.config.workdir, model: harness.config.model });
  await repl(harness, makeReadlineIO(rl));
}

// ...
if (isDirectRun) {
  main().catch((error: unknown) => {
    log.error("fatal", {}, error);
    process.exit(1);
  });
}
```

- [ ] **步骤 4：运行现有 CLI 测试验证不破坏行为**

运行：`pnpm vitest run test/cli/main.test.ts`
预期：PASS（现有测试全部通过）。

- [ ] **步骤 5：Commit**

```bash
git add src/cli/main.ts
git commit -m "feat(logger): integrate logger into CLI startup"
```

---

## 任务 3：provider + retry 日志

**文件：**
- 修改：`src/providers/openai.ts`、`src/providers/retry.ts`

- [ ] **步骤 1：openai.ts 请求/响应日志**

在 [openai.ts](f:/allProject/myProject/blh-claude-code-ts/src/providers/openai.ts) 顶部加：

```ts
import { createLogger } from "../core/logger.js";

const log = createLogger("providers.openai");
```

在 `chat()` 方法开头加请求日志，在 `chatCompletion()` 响应后加 usage 日志：

```ts
  async chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage> {
    log.debug("chat request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const response = await this.createCompletion({ ... });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("provider returned no choices");
    log.debug("chat response", { toolCalls: message.tool_calls?.length ?? 0 });
    return fromOpenAIMessage(message);
  }

  async chatCompletion(...) {
    log.debug("chatCompletion request", { model: this.config.model, messages: messages.length });
    const response = await this.createCompletion({ ... });
    // ...
    log.debug("chatCompletion response", {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
    });
    return { ... };
  }
```

- [ ] **步骤 2：retry.ts 重试日志**

在 [retry.ts](f:/allProject/myProject/blh-claude-code-ts/src/providers/retry.ts) 顶部加：

```ts
import { createLogger } from "../core/logger.js";

const log = createLogger("providers.retry");
```

在 `withRetry` 的 catch 分支、`await sleep(...)` 前加：

```ts
    } catch (error) {
      attempts += 1;
      if (attempts >= maxAttempts || !isRetryable(error)) throw error;
      const delay = retryDelay(attempts, error);
      log.warn("retrying", { attempt: attempts, delay });
      await sleep(delay);
    }
```

- [ ] **步骤 3：运行 provider 测试验证不破坏行为**

运行：`pnpm vitest run test/providers/`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/providers/openai.ts src/providers/retry.ts
git commit -m "feat(logger): log provider requests and retries"
```

---

## 任务 4：loop + hooks + approval 日志

**文件：**
- 修改：`src/core/loop.ts`、`src/core/hooks.ts`、`src/security/approval.ts`

- [ ] **步骤 1：loop.ts 每轮/工具调用日志**

在 [loop.ts](f:/allProject/myProject/blh-claude-code-ts/src/core/loop.ts) 顶部加：

```ts
import { createLogger } from "./logger.js";

const log = createLogger("core.loop");
```

在 `agentLoop` 的 `for (;;)` 循环体开头（`const compactor = harness.compactor;` 之前）加每轮日志；在工具调用循环里拿到 `name` 后加工具调用日志：

```ts
  for (;;) {
    log.debug("turn start", { messages: messages.length });
    // ...
    for (const call of toolCalls) {
      const name = call.function.name;
      log.info("tool call", { tool: name });
      // ...
    }
  }
```

- [ ] **步骤 2：hooks.ts 触发日志**

在 [hooks.ts](f:/allProject/myProject/blh-claude-code-ts/src/core/hooks.ts) 顶部加：

```ts
import { createLogger } from "./logger.js";

const log = createLogger("core.hooks");
```

在 `trigger` 与 `firstBlock` 各加一条 debug：

```ts
  async trigger<E extends HookEvent>(event: E, payload: HookPayloads[E]): Promise<Array<string | null>> {
    log.debug("trigger", { event });
    // ...
  }

  async firstBlock<E extends HookEvent>(event: E, payload: HookPayloads[E]): Promise<string | null> {
    log.debug("firstBlock", { event });
    // ...
  }
```

- [ ] **步骤 3：approval.ts deny/ask 日志**

在 [approval.ts](f:/allProject/myProject/blh-claude-code-ts/src/security/approval.ts) 顶部加：

```ts
import { createLogger } from "../core/logger.js";

const log = createLogger("security.approval");
```

在 `makePermissionHook` 返回的 hook 内，`deny` 分支加 warn，`ask` 决策加 debug：

```ts
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      return `denied by permission rule (${tool}: ${target})`;
    }
    // ...
    const answer = (await ask(`allow ${tool}(${target})? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      log.debug("approved", { tool, target });
      return null;
    }
    log.warn("denied by user", { tool, target });
    return "denied by user";
```

- [ ] **步骤 4：运行相关测试验证不破坏行为**

运行：`pnpm vitest run test/core/loop.test.ts test/core/hooks.test.ts test/security/approval.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/loop.ts src/core/hooks.ts src/security/approval.ts
git commit -m "feat(logger): log loop turns, hooks, and approvals"
```

---

## 任务 5：config 日志

**文件：**
- 修改：`src/core/config.ts`

- [ ] **步骤 1：配置来源与 apiKey 日志**

在 [config.ts](f:/allProject/myProject/blh-claude-code-ts/src/core/config.ts) 顶部加：

```ts
import { createLogger } from "./logger.js";

const log = createLogger("core.config");
```

在 `loadConfig` 内，读完文件后加 debug；把 apiKey 缺失的 `console.error` 换成 `log.error`：

```ts
  for (const filePath of findConfig(process.cwd())) {
    // ...
  }
  log.debug("config loaded", { files: findConfig(process.cwd()) });

  const apiKey = String(get("api_key", "OPENAI_API_KEY", ""));
  if (!apiKey) {
    log.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }
```

- [ ] **步骤 2：运行 config 测试验证不破坏行为**

运行：`pnpm vitest run test/core/config.test.ts`
预期：PASS。

- [ ] **步骤 3：Commit**

```bash
git add src/core/config.ts
git commit -m "feat(logger): log config loading and api key errors"
```

---

## 任务 6：迁移现有 console 日志

**文件：**
- 修改：`src/jobs/runtime.ts`、`src/jobs/cron.ts`、`src/memory/extract.ts`、`src/compaction/compactor.ts`

- [ ] **步骤 1：jobs/runtime.ts 迁移**

在 [runtime.ts](f:/allProject/myProject/blh-claude-code-ts/src/jobs/runtime.ts) 顶部加 `import { createLogger } from "../core/logger.js";` 与 `const log = createLogger("jobs.runtime");`，替换两处 `console.log`：

```ts
// line 97
log.warn("cron scheduler stopped", { error: String(error) });
// line 126
log.warn("cron scheduled turn failed", { retry: this.queueFailures, error: String(error) });
```

- [ ] **步骤 2：jobs/cron.ts 迁移**

顶部加 `import { createLogger } from "../core/logger.js";` 与 `const log = createLogger("jobs.cron");`，替换三处：

```ts
// line 260
log.warn("acknowledgement persistence failed", { error: String(saveError) });
// line 289
log.warn("could not load durable file", { file: path.basename(this.durablePath), error: String(loadError) });
// line 302
log.warn("skipped invalid saved job", { error: String(itemError) });
```

- [ ] **步骤 3：memory/extract.ts 迁移**

顶部加 `import { createLogger } from "../core/logger.js";` 与 `const log = createLogger("memory.extract");`，替换四处：

```ts
// line 103
log.info("stored records", { stored });
// line 107
log.warn("extraction skipped", { error: error instanceof Error ? error.message : String(error) });
// line 190
log.info("consolidated records", { from: records.length, to: consolidated.length });
// line 193
log.warn("consolidation skipped", { error: error instanceof Error ? error.message : String(error) });
```

- [ ] **步骤 4：compaction/compactor.ts 迁移（去掉 notify）**

在 [compactor.ts](f:/allProject/myProject/blh-claude-code-ts/src/compaction/compactor.ts) 顶部加 `import { createLogger } from "../core/logger.js";` 与 `const log = createLogger("compaction.compactor");`。

删除 `notify` 字段与构造参数：

```ts
export interface CompactorOptions {
  provider: ChatProvider;
  transcriptDir: string;
  toolResultsDir: string;
}

export class ContextCompactor {
  // ...
  constructor(options: CompactorOptions) {
    this.provider = options.provider;
    this.transcriptDir = options.transcriptDir;
    this.toolResultsDir = options.toolResultsDir;
  }
```

把三处 `this.notify(...)` 换成 `log.info(...)`：

```ts
// compactHistory 与 reactiveCompact 内
log.info("transcript saved", { path: transcript });
// prepare 内
log.info("auto compact");
```

- [ ] **步骤 5：运行迁移模块测试验证不破坏行为**

运行：`pnpm vitest run test/jobs/ test/memory/ test/compaction/`
预期：PASS。

- [ ] **步骤 6：全量 grep 确认无残留 console**

运行：`grep -rn "console\.log\|console\.error" src/`
预期：仅剩 `src/cli/repl.ts` 的 `print`、`src/cli/main.ts` 的 stdout 正常输出（`console.log(USAGE)`、`console.log(lastAssistantText(...))`）与 `config.ts` 已替换的 `log.error`（无 `console.error`）。

- [ ] **步骤 7：Commit**

```bash
git add src/jobs/runtime.ts src/jobs/cron.ts src/memory/extract.ts src/compaction/compactor.ts
git commit -m "refactor(logger): migrate scattered console logs to logger"
```

---

## 任务 7：收尾验证

- [ ] **步骤 1：全量测试**

运行：`pnpm vitest run`
预期：PASS（原有 348 + 新增 8 = 356 左右）。

- [ ] **步骤 2：lint + typecheck + build**

运行：`pnpm lint && pnpm typecheck && pnpm build`
预期：全部通过。

- [ ] **步骤 3：冒烟验证（真实运行观察日志）**

运行：`pnpm dev`
输入任意一句（例如 `列出当前目录文件`），观察终端出现 `[info] [core.loop] tool call ...` 格式的日志；退出后检查 `.blh/logs/blh-YYYY-MM-DD.log` 文件已生成且含 JSON 行。

- [ ] **步骤 4：Commit**

```bash
git add .
git commit -m "test(logger): full validation"
```
