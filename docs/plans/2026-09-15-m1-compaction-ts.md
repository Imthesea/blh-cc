# blh-claude-code-ts M1.1：上下文压缩（compaction）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移植 Python 版 `blh.compaction` 的四步上下文压缩管线到 TS `src/compaction/`，让长对话在超阈值时自动整理/压缩，并在 API 拒绝（prompt too long）时反应式恢复。

**架构：** 新增 `ContextCompactor`：每次模型调用前执行 `prepare()` 管线（toolResultBudget → snipCompact → 超限时 microCompact → fitToolResults → compactHistory），低成本可恢复操作优先，模型摘要最后。`Harness` 从重建式改为累积式会话（`newSession()` + `runTurn(messages, text)`）并增加可选 `compactor` 组件；`agentLoop` 在 `provider.chat` 前调用 `prepare()`、捕获上下文超长错误后 `reactiveCompact()` 重试一次；新增 `compact` 工具供模型主动请求压缩。

**技术栈：** TypeScript 5.x（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）、ESM（NodeNext）、vitest 2.x、eslint 9；摘要调用复用现有 `OpenAIProvider`（测试用 fake `ChatProvider` 驱动）。

**移植蓝本：** `F:\allProject\myProject\blh-claude-code\docs\plans\2026-09-14-m1-compaction.md`（Python 版，8 任务；用例逻辑改写适配，不重写）。

**范围说明：**
- 本计划仅覆盖 M1 的第一个子包 compaction；planning（M1.2）、memory（M1.3）后续另行编写计划。
- token 估算采用**本地字符估算**（`estimateChars`），与蓝本一致；usage 读取留待后续需要时再做。
- 压缩产物写入 workdir 下 `.transcripts/`（历史留档 JSONL）与 `.task_outputs/tool-results/`（大结果全文），均带可恢复路径。

## 相对 Python 蓝本的 TS 适配要点

| Python 蓝本 | TS 实现 |
|---|---|
| `provider.chat` 同步调用 | `ChatProvider.chat` 返回 Promise → `summarizeHistory`/`compactHistory`/`reactiveCompact`/`prepare` 全部为 `async` |
| 消息为 dict，`.get()` 访问 | 强类型 `ChatMessage`（src/core/types.ts）；tool 消息内容经 `contentOf()` 助手读取（`null` → `""`），杜绝 `as` 断言 |
| `error.status_code == 400` | OpenAI SDK 错误字段为 `status`；`isPromptTooLong(error: unknown)` 用类型守卫窄化 |
| `print("[transcript saved: ...]")` | 构造函数注入可选 `notify?: (message: string) => void`，默认静默；`main.ts` 装配时传 `console.log`，测试不传 |
| `pathlib.Path` + 同步 IO | `node:path` + `node:fs` 同步 API（`mkdirSync`/`writeFileSync`/`readFileSync`/`existsSync`）；文件操作保持同步，`async` 仅由摘要调用引入 |
| `write_transcript = lambda ...` 打桩 | TS 无法便捷替换实例方法 → 测试用子类覆写或注入 fake provider 达到同等效果（见任务 5） |
| M0 TS 的 `Harness.runTurn(text)` 重建式 | 任务 7 一并迁移为累积式：`newSession()` + `runTurn(messages, text)`，`repl.ts`/`main.ts`/相关测试同步适配 |

## 命名映射（蓝本 snake_case → TS camelCase 语义化）

`estimate_chars`→`estimateChars`、`has_tool_use`→`hasToolUse`、`is_tool_result`→`isToolResult`、`unseen_tool_result_positions`→`unseenToolResultPositions`、`write_transcript`→`writeTranscript`、`save_output`→`saveOutput`、`persisted_output_path`→`persistedOutputPath`、`persisted_preview`→`persistedPreview`、`persist_large_output`→`persistLargeOutput`、`tool_result_budget`→`toolResultBudget`、`is_archive_marker`→`isArchiveMarker`、`snip_compact`→`snipCompact`、`micro_compact`→`microCompact`、`fit_tool_results`→`fitToolResults`、`summary_input`→`summaryInput`、`summarize_history`→`summarizeHistory`、`summary_message`→`summaryMessage`、`compact_history`→`compactHistory`、`reactive_compact`→`reactiveCompact`、`is_prompt_too_long`→`isPromptTooLong`、`register_compact_tool`→`registerCompactTool`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/compaction/compactor.ts` | `ContextCompactor`：四步管线 + 持久化 + 摘要 + 反应式压缩 |
| `src/compaction/compactTool.ts` | `registerCompactTool`（compact 工具 schema 注册；执行由 loop 拦截） |
| `src/providers/openai.ts` | 追加 `isPromptTooLong` 启发式判定 |
| `src/core/harness.ts` | 累积式会话改造（`newSession`/`runTurn(messages, text)`）+ 可选 `compactor`；system prompt 加压缩消息指引 |
| `src/core/loop.ts` | `prepare()` 前置、反应式压缩重试一次、`compact` 工具拦截 |
| `src/cli/repl.ts` | 持有会话数组跨轮复用；`TurnRunner` 接口更新 |
| `src/cli/main.ts` | `buildHarness` 装配 compactor 并注册 compact 工具；`-p` 模式适配累积式 |
| `.gitignore` | 忽略 `.transcripts/`、`.task_outputs/` |
| `test/compaction/compactor.test.ts` | compactor 全部单元/管线测试 |
| `test/core/loop.test.ts` | 追加压缩集成测试（prepare 前置/反应式/compact 工具） |
| `test/core/harness.test.ts` | 适配累积式 `runTurn` 签名 |
| `test/cli/repl.test.ts` | 适配新 `TurnRunner` 接口 |
| `test/cli/main.test.ts` | 新建：`buildHarness` 装配测试 |
| `test/providers/openai.test.ts` | 追加 `isPromptTooLong` 测试 |
| `test/integration/agent.test.ts` | 适配累积式 Harness API |

---

<!-- 待续：任务 1 -->
