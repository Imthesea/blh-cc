# 日志系统设计（Logging System）

- 日期：2026-09-16
- 状态：已批准

## 1. 背景与目标

blh-claude-code-ts 当前没有统一的日志基础设施：只有 17 处散落的 `console.log` / `console.error`，格式不统一（`[cron]`、`[Memory: ...]`、裸 `console.log`），而 provider 层、hook 层、loop 层完全没有日志。运行时一旦出错（例如 API 返回 402、超时、工具执行失败），只能靠终端报错，无法事后定位。

目标：建立一套统一、可分级、可持久化的日志系统，覆盖 agent 运行的关键链路，让任何问题都能通过日志快速定位。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 输出目标 | 终端 + 文件 |
| 实现方式 | 自研轻量 logger（零新依赖） |
| 日志级别 | 四级 `debug` / `info` / `warn` / `error`，默认 `info` |
| 文件位置 | 项目工作目录下 `.blh/logs/` |

## 3. 架构

### 3.1 核心模块 `src/core/logger.ts`

全项目统一日志入口，模块化获取：

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

export function createLogger(name: string): Logger;
export function initLogger(workdir: string, level?: LogLevel): void;
```

- `initLogger(workdir, level)`：在 CLI 启动时调用一次，设置日志文件目录（`<workdir>/.blh/logs/`）和级别。
- `createLogger("providers.openai")`：模块获取带名字的 logger，无需每次手写模块名。
- `child(name)`：派生子 logger，前缀用 `.` 拼接，例如 `createLogger("core").child("loop")` → `core.loop`。

### 3.2 级别过滤

- 级别顺序：`debug` < `info` < `warn` < `error`。
- 低于当前级别的日志直接丢弃，不打到终端也不写文件。
- 级别由环境变量 `BLH_LOG_LEVEL` 控制，默认 `info`。

### 3.3 双输出

**终端（stderr）**——人类可读，实时调试用：

```
[16:03:22] [info] [providers.openai] chat request model=gpt-4o-mini tools=5
```

- 时间格式 `HH:MM:SS`。
- 级别 + 模块名 + 消息 + 可选字段（`key=value`，复杂值如对象/数组用 JSON 序列化）。
- 写 stderr，不污染 stdout 的正常输出。

**文件（`.blh/logs/blh-YYYY-MM-DD.log`）**——结构化 JSON 行，事后分析用：

```json
{"time":"2026-09-16T08:03:22.000Z","level":"info","module":"providers.openai","msg":"chat request","fields":{"model":"gpt-4o-mini","tools":5}}
```

- 每行一条完整 JSON，便于 `grep` / `jq` 过滤分析。
- 按天滚动：文件名带日期，跨天自动写到新文件。
- 追加写入，不覆盖历史。

### 3.4 错误堆栈

`error(message, fields, error)` 第三个参数接受 `Error` 对象，自动把 `error.stack` 写入日志的 `stack` 字段（终端与文件都带）。调用方无需手动拼 `error.message` / `error.stack`。

## 4. 接入点

| 模块 | 打什么日志 | 级别 |
|------|-----------|------|
| `providers.openai` | 请求前（model / 消息数 / 工具数）、响应后 token 用量 | debug |
| `providers.retry` | 每次重试（第几次、延迟秒数） | warn |
| `core.loop` | 每轮开始 / 结束、工具调用（工具名 + 参数摘要）、工具结果 | info / debug |
| `core.hooks` | PreToolUse / PostToolUse 触发（工具名） | debug |
| `security.approval` | deny 命中（被拒命令）、ask 决策（放行 / 拒绝） | warn / debug |
| `core.config` | 配置来源、apiKey 缺失 | debug / error |
| `cli.main` | 启动（workdir / model）、崩溃（含堆栈） | info / error |
| `jobs`（runtime / cron） | 现有 cron 日志迁移 | 原级别 |
| `memory`（extract） | 现有 memory 日志迁移 | 原级别 |
| `compaction`（compactor） | 压缩提示迁移到 logger | info |

现有 17 处零散 `console.log` / `console.error` 全部迁移到 `createLogger(...)`，删除直接 `console` 调用（`cli/repl.ts` 的 `print` 与 `cli/main.ts` 的 stdout 正常输出除外）。

## 5. 配置

- `BLH_LOG_LEVEL`：控制日志级别，取值 `debug` / `info` / `warn` / `error`，默认 `info`。
- 文件目录：固定 `<workdir>/.blh/logs/`，由 `initLogger(workdir)` 确定，不新增 CLI 参数、不新增配置项。

## 6. 测试策略

- `test/core/logger.test.ts`：
  - 级别过滤（低于当前级别的丢弃）。
  - 双输出（终端 stderr、文件 JSON 行）。
  - 子 logger 前缀拼接。
  - 错误堆栈写入 `stack` 字段。
  - 按天滚动（文件名随日期变化）。
  - 终端的格式化与文件的格式化抽成纯函数，可独立测试；文件落盘用临时目录验证，不依赖真实磁盘与时间。
- 接入点验证：用 mock logger 断言关键链路（provider 错误、loop 工具调用、approval deny）确实打了日志。

## 7. 非目标（YAGNI）

- 不做日志远程上报 / 集中收集。
- 不做日志压缩、归档、按大小滚动（只按天滚动）。
- 不做异步日志队列（日志量小，同步写足够）。
- 不引入第三方日志库。
