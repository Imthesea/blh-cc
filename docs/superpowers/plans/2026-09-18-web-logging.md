# Web 日志系统 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把日志能力统一扩展到 `apps/web-server`、`apps/web`、`packages/web-client` 三端，浏览器端日志回传后端落盘，全部为「方便找 bug」。

**架构：** 抽取共享包 `@blh/logger`（`packages/logger`），条件导出 `node`/`browser` 两个入口，共享 `types` + `format` 纯函数。根包与 web-server 用 node 入口（写 stderr + 文件）；前端用 browser 入口（写 console + remote transport 回传）。web-server 新增 `POST /api/log` 接收前端日志落盘。

**技术栈：** TypeScript 5.x、pnpm workspace、Node `node:fs`/`node:http`、Vite、vitest。

**规格：** `docs/superpowers/specs/2026-09-18-web-logging-design.md`

---

## 文件结构

- 创建 `packages/logger/`（`package.json`、`tsconfig.json`、`vitest.config.ts`、`src/types.ts`、`src/format.ts`、`src/node.ts`、`src/browser.ts`、`test/format.test.ts`、`test/node.test.ts`、`test/browser.test.ts`）
- 删除 `src/core/logger.ts`、`test/core/logger.test.ts`
- 修改根包 13 处 logger import + `package.json`（加 `@blh/logger` 依赖）
- 修改 `apps/web-server/src/*`（接入 logger + `/api/log` 端点）+ `test/log.test.ts`
- 修改 `packages/web-client/`（`src/log.ts`、`src/index.ts`、`src/api.ts`、`src/sse.ts`、`tsconfig.json`、`package.json`）
- 修改 `apps/web/`（`main.tsx`、`hooks/useAgentEvents.ts`、`vite.config.ts`、`tsconfig.json`、`package.json`）

---

## 任务 1：创建 @blh/logger 包

**文件：**
- 创建：`packages/logger/package.json`
- 创建：`packages/logger/tsconfig.json`
- 创建：`packages/logger/vitest.config.ts`
- 创建：`packages/logger/src/types.ts`
- 创建：`packages/logger/src/format.ts`
- 创建：`packages/logger/src/node.ts`
- 创建：`packages/logger/src/browser.ts`
- 测试：`packages/logger/test/format.test.ts`、`test/node.test.ts`、`test/browser.test.ts`

- [ ] **步骤 1：写包配置**

创建 `packages/logger/package.json`：

```json
{
  "name": "@blh/logger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/node.ts",
      "node": "./src/node.ts",
      "browser": "./src/browser.ts",
      "default": "./src/node.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

创建 `packages/logger/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

创建 `packages/logger/vitest.config.ts`：

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **步骤 2：写类型与格式化（含共享 logger 核心）**

创建 `packages/logger/src/types.ts`：

```ts
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

export interface LogSink {
  write(entry: LogEntry): void;
}
```

创建 `packages/logger/src/format.ts`：

```ts
import type { LogEntry, LogFields, Logger, LogLevel, LogSink } from "./types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function terminalTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fileDate(date: Date): string {
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

/** 跨环境的 logger 核心：级别过滤 + 多个 sink 输出。node/browser 各自组装 sink。 */
export class CoreLogger implements Logger {
  constructor(
    private readonly name: string,
    private readonly sinks: LogSink[],
    private readonly minLevel: () => LogLevel,
  ) {}

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel()]) return;
    const entry: LogEntry = {
      time: new Date(),
      level,
      module: this.name,
      message,
      fields,
    };
    for (const sink of this.sinks) sink.write(entry);
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
    return new CoreLogger(`${this.name}.${name}`, this.sinks, this.minLevel);
  }
}
```

- [ ] **步骤 3：写 node 入口**

创建 `packages/logger/src/node.ts`：

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { CoreLogger, fileDate, formatFile, formatTerminal } from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile } from "./format.js";

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

export function resetLogger(): void {
  currentLevel = "info";
  logDir = null;
}

/** 直接把一条日志落盘（不经过级别过滤、保留 entry 自己的 module）。供 web-server 接收前端日志用。 */
export function appendRawEntry(entry: LogEntry): void {
  if (logDir === null) return;
  const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
  appendFileSync(filePath, formatFile(entry), "utf8");
}

function terminalSink(): LogSink {
  return { write: (entry) => process.stderr.write(formatTerminal(entry) + "\n") };
}

function fileSink(): LogSink {
  return {
    write: (entry) => {
      if (logDir === null) return;
      const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
      appendFileSync(filePath, formatFile(entry), "utf8");
    },
  };
}

export function createLogger(name: string): Logger {
  return new CoreLogger(name, [terminalSink(), fileSink()], () => currentLevel);
}
```

- [ ] **步骤 4：写 browser 入口**

创建 `packages/logger/src/browser.ts`：

```ts
import { CoreLogger, formatTerminal } from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile } from "./format.js";

let currentLevel: LogLevel = "info";
let remoteTransport: ((entry: LogEntry) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setRemoteTransport(fn: (entry: LogEntry) => void): void {
  remoteTransport = fn;
}

export function resetRemoteTransport(): void {
  remoteTransport = null;
}

function consoleSink(): LogSink {
  return {
    write: (entry) => {
      const line = formatTerminal(entry);
      switch (entry.level) {
        case "debug":
          console.debug(line);
          break;
        case "info":
          console.info(line);
          break;
        case "warn":
          console.warn(line);
          break;
        case "error":
          console.error(line);
          break;
      }
    },
  };
}

function remoteSink(): LogSink {
  return { write: (entry) => remoteTransport?.(entry) };
}

export function createLogger(name: string): Logger {
  return new CoreLogger(name, [consoleSink(), remoteSink()], () => currentLevel);
}
```

- [ ] **步骤 5：写测试**

创建 `packages/logger/test/format.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatFile, formatTerminal } from "../src/format.js";

describe("formatTerminal", () => {
  it("渲染时间、级别、模块、消息、字段", () => {
    const line = formatTerminal({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web-server.http",
      message: "chat request",
      fields: { model: "gpt-4o-mini", tools: 5 },
    });
    expect(line).toContain("[info]");
    expect(line).toContain("[web-server.http]");
    expect(line).toContain("chat request");
    expect(line).toContain("model=gpt-4o-mini");
    expect(line).toContain("tools=5");
  });
});

describe("formatFile", () => {
  it("渲染单行 JSON", () => {
    const line = formatFile({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web.app",
      message: "turn",
      fields: {},
    });
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("web.app");
    expect(parsed.msg).toBe("turn");
    expect(parsed.time).toBe("2026-09-18T08:03:22.000Z");
  });
});
```

创建 `packages/logger/test/node.test.ts`：

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, initLogger, resetLogger } from "../src/node.js";

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

describe("node logger", () => {
  it("initLogger 后写文件", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("providers.openai");
    log.info("chat request", { model: "m" });
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-18.log");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("chat request");
  });

  it("未 initLogger 时只写 stderr 不写文件", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    log.info("hello");
    expect(write).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, ".blh", "logs"))).toBe(false);
  });

  it("过滤 debug（默认 info 级别）", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.debug("hidden");
    log.info("shown");
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-18.log");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("shown");
    expect(content).not.toContain("hidden");
  });

  it("child 拼接名字", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("core").child("loop");
    log.info("turn");
    expect(write.mock.calls[0]?.[0]).toContain("[core.loop]");
  });

  it("error 附带消息与堆栈", () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    log.error("failed", {}, new Error("boom"));
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-18.log");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("failed: boom");
    expect(content).toContain("stack");
  });
});
```

创建 `packages/logger/test/browser.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  resetRemoteTransport,
  setLogLevel,
  setRemoteTransport,
} from "../src/browser.js";

afterEach(() => {
  resetRemoteTransport();
  vi.restoreAllMocks();
});

describe("browser logger", () => {
  it("默认写 console（info 级别用 console.info）", () => {
    setLogLevel("info");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createLogger("web.app");
    log.info("hello");
    expect(info).toHaveBeenCalled();
  });

  it("过滤 debug（info 级别）", () => {
    setLogLevel("info");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("web.app");
    log.debug("hidden");
    expect(debug).not.toHaveBeenCalled();
  });

  it("setRemoteTransport 后转发条目", () => {
    setLogLevel("info");
    const remote = vi.fn();
    setRemoteTransport(remote);
    const log = createLogger("web.app");
    log.info("hello", { a: 1 });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0]?.[0]).toMatchObject({ module: "web.app", message: "hello" });
  });
});
```

- [ ] **步骤 6：运行测试验证通过**

运行：`pnpm --filter @blh/logger test`
预期：PASS（format 2 + node 5 + browser 3 = 10 tests）。

- [ ] **步骤 7：运行 typecheck 验证通过**

运行：`pnpm --filter @blh/logger typecheck`
预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add packages/logger
git commit -m "feat(logger): extract @blh/logger shared package"
```

---

## 任务 2：根包迁移到 @blh/logger

**文件：**
- 删除：`src/core/logger.ts`、`test/core/logger.test.ts`
- 修改：`package.json`（加依赖）
- 修改：13 处 import（见步骤 2）

- [ ] **步骤 1：加依赖**

在 [package.json](f:/allProject/myProject/blh-claude-code-ts/package.json) 的 `dependencies` 里，`"@blh/web-server": "workspace:*"` 后加一行：

```json
    "@blh/logger": "workspace:*",
```

- [ ] **步骤 2：替换 13 处 import**

把这些文件的 logger import 全部从相对路径改为 `@blh/logger`（`import { ... } from "@blh/logger";`，保留原花括号内的符号）：

1. `src/providers/retry.ts`：`../core/logger.js` → `@blh/logger`
2. `src/compaction/compactor.ts`：`../core/logger.js` → `@blh/logger`
3. `src/providers/openai.ts`：`../core/logger.js` → `@blh/logger`
4. `src/jobs/runtime.ts`：`../core/logger.js` → `@blh/logger`
5. `src/jobs/cron.ts`：`../core/logger.js` → `@blh/logger`
6. `src/cli/harness.ts`：`../core/logger.js` → `@blh/logger`（导入的是 `initLogger`）
7. `src/cli/main.ts`：`../core/logger.js` → `@blh/logger`（导入的是 `createLogger`）
8. `src/core/config.ts`：`./logger.js` → `@blh/logger`
9. `src/memory/extract.ts`：`../core/logger.js` → `@blh/logger`
10. `src/security/approval.ts`：`../core/logger.js` → `@blh/logger`
11. `src/core/events.ts`：`./logger.js` → `@blh/logger`
12. `src/core/loop.ts`：`./logger.js` → `@blh/logger`
13. `src/core/hooks.ts`：`./logger.js` → `@blh/logger`

- [ ] **步骤 3：删除旧实现与旧测试**

删除 `src/core/logger.ts` 与 `test/core/logger.test.ts`（实现与测试已在任务 1 迁入 `packages/logger`）。

- [ ] **步骤 4：安装依赖**

运行：`pnpm install --no-frozen-lockfile`
预期：成功，`@blh/logger` 链接到 node_modules。

- [ ] **步骤 5：全量验证**

运行：`pnpm typecheck && pnpm test && pnpm build`
预期：全部通过（logger 测试已在 @blh/logger 包，根包无 logger.test.ts）。

- [ ] **步骤 6：Commit**

```bash
git add package.json pnpm-lock.yaml src test
git commit -m "refactor(logger): migrate root package to @blh/logger"
```

---

## 任务 3：web-server 接入 logger + /api/log 端点

**文件：**
- 修改：`apps/web-server/package.json`
- 修改：`apps/web-server/src/index.ts`
- 修改：`apps/web-server/src/http.ts`
- 修改：`apps/web-server/src/session.ts`
- 修改：`apps/web-server/src/approval.ts`
- 测试：`apps/web-server/test/log.test.ts`

- [ ] **步骤 1：加依赖**

在 `apps/web-server/package.json` 的 `devDependencies` 前加 `dependencies`：

```json
  "dependencies": {
    "@blh/logger": "workspace:*"
  },
```

- [ ] **步骤 2：startWebServer 初始化并打日志**

修改 [index.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web-server/src/index.ts)，顶部加 import 与模块 logger，`startWebServer` 开头 `initLogger`，监听后记 info：

```ts
import { createLogger, initLogger } from "@blh/logger";
// ... 其余 import 不变

const log = createLogger("web-server.index");
```

在 `startWebServer` 函数体开头（`const workdir = options.workdir;` 之后）加：

```ts
  initLogger(workdir);
```

在 `await new Promise(...)` 监听成功后（`server.listen(...)` 那行之后）加：

```ts
  log.info("web server started", { url: `http://127.0.0.1:${port}`, workdir });
```

把 `close` 回调改为也记日志：

```ts
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else {
            log.info("web server closed");
            resolve();
          }
        });
      }),
```

- [ ] **步骤 3：http.ts 打日志 + 新增 /api/log 端点**

修改 [http.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web-server/src/http.ts)。

顶部加 import 与模块 logger：

```ts
import { appendRawEntry, createLogger, type LogLevel } from "@blh/logger";
```

```ts
const log = createLogger("web-server.http");

function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
```

在 `handleApi` 开头（CSRF 校验之后）加请求日志：

```ts
  log.debug("request", { method, pathname });
```

在 `handleApi` 的 `/api/approval` 分支之前，新增 `/api/log` 分支：

```ts
  if (method === "POST" && pathname === "/api/log") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const entries = body.entries;
    if (!Array.isArray(entries)) {
      json(res, 400, { error: "entries is required" });
      return;
    }
    for (const raw of entries) {
      const e = raw as Record<string, unknown>;
      const level = e.level;
      if (!isLogLevel(level)) continue;
      const message = typeof e.message === "string" ? e.message : "";
      const module = typeof e.module === "string" ? e.module : "web";
      const time = new Date(typeof e.time === "string" ? e.time : Date.now());
      const fields =
        typeof e.fields === "object" && e.fields !== null
          ? (e.fields as Record<string, unknown>)
          : {};
      appendRawEntry({ time, level, module, message, fields });
    }
    log.debug("frontend logs received", { count: entries.length });
    json(res, 202, { accepted: true });
    return;
  }
```

- [ ] **步骤 4：session.ts 打日志**

修改 [session.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web-server/src/session.ts)，顶部加：

```ts
import { createLogger } from "@blh/logger";

const log = createLogger("web-server.session");
```

在 `create` 方法里 `this.current = handle;` 前加 `log.debug("session created", { file: handle.file });`；
在 `resume` 方法里 `this.current = handle;` 前加 `log.debug("session resumed", { file: fullPath });`；
在 `runTurn` 方法里 `return this.lock.withLock(run)...` 前加 `log.debug("run turn", { id, text });`。

- [ ] **步骤 5：approval.ts 打日志**

修改 [approval.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web-server/src/approval.ts)，顶部加：

```ts
import { createLogger } from "@blh/logger";

const log = createLogger("web-server.approval");
```

在 `ask` 里 `this.broadcast(...)` 之后加 `log.debug("approval requested", { requestId, tool: req.tool });`；
在 `resolve` 里 `entry.resolve(decision);` 前加 `log.debug("approval resolved", { requestId, decision });`。

- [ ] **步骤 6：写 /api/log 测试**

创建 `apps/web-server/test/log.test.ts`：

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLogger, resetLogger } from "@blh/logger";
import { createWebServer, type WebContext } from "../src/http.js";
import { SSEBroadcaster } from "../src/bridge.js";
import { SessionManager } from "../src/session.js";
import { ApprovalCoordinator } from "../src/approval.js";
import type { TurnLock, WebTurnRunner } from "../src/types.js";
import { makeTestSessionStore } from "./helpers.js";

function makeContext(workdir: string): WebContext {
  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: async () => {},
  };
  const lock: TurnLock = { withLock: async <T,>(fn: () => Promise<T>) => fn() };
  const sessionStore = makeTestSessionStore();
  const session = new SessionManager(runner, lock, (event) => broadcaster.broadcast(event), approvals, sessionStore);
  session.create(workdir);
  return { session, broadcaster, workdir, staticDir: null, sessionStore };
}

async function listen(ctx: WebContext): Promise<{ server: Server; url: string }> {
  const server = createWebServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

let servers: Server[] = [];
let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-log-"));
  initLogger(tmpDir, "info");
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  resetLogger();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/log", () => {
  it("落盘前端日志", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({
        entries: [
          { time: "2026-09-18T08:00:00.000Z", level: "info", module: "web.app", message: "hello", fields: {} },
        ],
      }),
    });
    expect(res.status).toBe(202);
    const file = path.join(tmpDir, ".blh", "logs", "blh-2026-09-18.log");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("web.app");
  });

  it("缺少 CSRF 头返回 403", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("entries 非数组返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ entries: "nope" }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **步骤 7：运行 web-server 测试与 typecheck**

运行：`pnpm --filter @blh/web-server test`
预期：PASS（原 27 + 新增 3 = 30 tests）。

运行：`pnpm --filter @blh/web-server typecheck`
预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add apps/web-server
git commit -m "feat(web-server): add logging and /api/log endpoint"
```

---

## 任务 4：web-client 接入 logger + reportLogs

**文件：**
- 修改：`packages/web-client/package.json`
- 修改：`packages/web-client/tsconfig.json`
- 创建：`packages/web-client/src/log.ts`
- 修改：`packages/web-client/src/index.ts`
- 修改：`packages/web-client/src/api.ts`
- 修改：`packages/web-client/src/sse.ts`

- [ ] **步骤 1：加依赖 + tsconfig paths**

修改 `packages/web-client/package.json`，加 dependencies：

```json
  "dependencies": {
    "@blh/logger": "workspace:*"
  },
```

修改 `packages/web-client/tsconfig.json`，加 `paths`（指向 browser 入口，避免 node:fs 污染）：

```json
    "noEmit": true,
    "paths": {
      "@blh/logger": ["../logger/src/browser.ts"]
    }
```

- [ ] **步骤 2：写 reportLogs**

创建 `packages/web-client/src/log.ts`：

```ts
import type { LogEntry } from "@blh/logger";

/** 把前端日志回传后端落盘；失败静默降级（不抛错，避免触发新的远程日志）。 */
export async function reportLogs(entries: LogEntry[]): Promise<void> {
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ entries }),
    });
  } catch {
    // 忽略：回传失败不致命
  }
}
```

修改 `packages/web-client/src/index.ts`，加一行导出：

```ts
export { reportLogs } from "./log.js";
```

- [ ] **步骤 3：api.ts 打日志**

修改 [api.ts](f:/allProject/myProject/blh-claude-code-ts/packages/web-client/src/api.ts)，顶部加 import 与模块 logger，`request` 失败时打日志：

```ts
import { createLogger } from "@blh/logger";
import type { ApprovalDecision, ChatMessage, SessionInfo, SessionListItem } from "./types.js";

const log = createLogger("web-client.api");
```

在 `request` 的 `if (!res.ok)` 分支里、`throw` 之前加：

```ts
    log.warn("request failed", { path, status: res.status, error: body?.error ?? null });
```

- [ ] **步骤 4：sse.ts 打日志**

修改 [sse.ts](f:/allProject/myProject/blh-claude-code-ts/packages/web-client/src/sse.ts)，顶部加 import 与模块 logger：

```ts
import { createLogger } from "@blh/logger";
import type { WebEvent } from "./types.js";

const log = createLogger("web-client.sse");
```

在 `connectEvents` 里 `es.addEventListener(type, ...)` 的 catch 分支加日志：

```ts
      } catch {
        log.warn("bad SSE payload", { type });
        onEvent({ type: "error", message: `bad SSE payload for ${type}` });
      }
```

- [ ] **步骤 5：typecheck + 根测试**

运行：`pnpm --filter @blh/web-client typecheck`
预期：PASS。

运行：`pnpm test`
预期：PASS（无 web-client 单测变化，回归确认）。

- [ ] **步骤 6：Commit**

```bash
git add packages/web-client
git commit -m "feat(web-client): add logging and reportLogs"
```

---

## 任务 5：apps/web 组装 logger 并打日志

**文件：**
- 修改：`apps/web/package.json`
- 修改：`apps/web/tsconfig.json`
- 修改：`apps/web/vite.config.ts`
- 修改：`apps/web/src/main.tsx`
- 修改：`apps/web/src/hooks/useAgentEvents.ts`

- [ ] **步骤 1：加依赖 + alias/paths**

修改 `apps/web/package.json` 的 `dependencies`，加：

```json
    "@blh/logger": "workspace:*",
```

修改 `apps/web/tsconfig.json` 的 `paths`，加 `@blh/logger`：

```json
    "paths": {
      "@blh/web-client": ["../../packages/web-client/src/index.ts"],
      "@blh/logger": ["../../packages/logger/src/browser.ts"]
    }
```

修改 [vite.config.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web/vite.config.ts) 的 `resolve.alias`，加：

```ts
      "@blh/logger": path.resolve(root, "../../packages/logger/src/browser.ts"),
```

- [ ] **步骤 2：main.tsx 注册 remote transport**

修改 [main.tsx](f:/allProject/myProject/blh-claude-code-ts/apps/web/src/main.tsx)，顶部加 import 并在 render 前注册：

```ts
import { setRemoteTransport } from "@blh/logger";
import { reportLogs } from "@blh/web-client";

setRemoteTransport((entry) => {
  void reportLogs([entry]);
});
```

- [ ] **步骤 3：useAgentEvents 打日志**

修改 [useAgentEvents.ts](f:/allProject/myProject/blh-claude-code-ts/apps/web/src/hooks/useAgentEvents.ts)，顶部加 import 与模块 logger：

```ts
import { createLogger } from "@blh/logger";
```

```ts
const log = createLogger("web.app");
```

在 `connectEvents` 回调的 `case "error":` 分支加 `log.warn("agent error", { message: event.message });`；
在 `send` 的 catch 分支加 `log.error("send failed", {}, e);`；
在 `respond` 的 catch 分支加 `log.error("respond failed", {}, e);`。

- [ ] **步骤 4：typecheck + build**

运行：`pnpm --filter @blh/web typecheck`
预期：PASS。

运行：`pnpm --filter @blh/web build`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add apps/web
git commit -m "feat(web): wire logger with console + remote transport"
```

---

## 任务 6：收尾验证

- [ ] **步骤 1：安装 + 全量测试**

运行：`pnpm install --no-frozen-lockfile`
预期：成功。

运行：`pnpm --filter @blh/logger test && pnpm --filter @blh/web-server test && pnpm test`
预期：全部 PASS。

- [ ] **步骤 2：全量 typecheck + build**

运行：`pnpm --filter @blh/logger typecheck && pnpm --filter @blh/web-server typecheck && pnpm --filter @blh/web-client typecheck && pnpm --filter @blh/web typecheck && pnpm typecheck`
预期：全部 PASS。

运行：`pnpm build && pnpm --filter @blh/web build`
预期：全部 PASS。

- [ ] **步骤 3：Commit**

```bash
git add .
git commit -m "test(logging): full validation"
```
