# 会话留档优化设计：全量快照 → 单一会话文件

- 日期：2026-09-17
- 状态：待审查

## 1. 背景与目标

当前 `.transcripts/` 的留档方式存在严重冗余：`ContextCompactor` 在每次压缩（`snipCompact` / `compactHistory` / `reactiveCompact`）时，都调用 `writeTranscript(messages)` 把**当时的全量消息**写成一份新的 jsonl 快照。对话越长，触发的压缩次数越多，每个新文件都重复包含之前几乎全部对话，磁盘与阅读成本随对话长度平方级增长。

参考 re-pi 的方案（`re-pi/packages/coding-agent/src/core/session-manager.ts` 用单一 JSONL 文件 `appendFileSync` 持续追加，压缩时只在会话内插入摘要条目、不导出快照），目标是把本项目改成「**单一会话文件持续 append**」，从根上消除冗余。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 留档模型 | 单一 JSONL 会话文件持续 append（不引入 re-pi 的 parentId 树 / 分支 / 恢复回放） |
| 会话数据结构 | 保留现有内存 `ChatMessage[]`，不改模型 |
| 写入时机 | 每条消息（user / assistant / tool）产生后立即 append |
| 文件生命周期 | 支持 `--continue` 续写；默认恢复最新文件，可 `--continue <文件名>` |
| 压缩摘要落盘 | 不落盘；`--continue` 恢复读全量后由 `prepare` 自动重压（可能重调一次 LLM） |
| 文件位置 | 新建 `.sessions/` 目录，文件命名 `session_<毫秒时间戳>.jsonl` |
| 持久化范围 | 仅 REPL 交互模式；`-p` 单次模式不持久化 |
| 大结果转存 | `.task_outputs/tool-results/` 保留不动（独立功能，与本次无关） |

## 3. 架构

### 3.1 新增 `src/session/store.ts` —— `SessionStore`

会话文件的唯一读写入口，职责与压缩解耦：

```ts
import type { ChatMessage } from "../core/types.js";

export class SessionStore {
  static create(workdir: string): SessionStore;      // 新建 .sessions/session_<now>.jsonl，返回持有该文件的实例
  static open(filePath: string): SessionStore;        // 打开已有文件（append 模式）
  static latest(workdir: string): string | null;      // 返回 .sessions/ 下 mtime 最新的文件路径；无则 null
  static load(filePath: string): ChatMessage[];       // 逐行 JSON.parse 还原消息数组

  readonly path: string;

  append(message: ChatMessage): void;                 // JSON.stringify + "\n"，appendFileSync 追加
}
```

- 目录 `.sessions/` 在 `create` / `latest` 时 `mkdirSync(recursive: true)` 创建。
- `latest` 用 `readdirSync` + `statSync(...).mtimeMs` 排序，取最新；`load` 遇到空行或非法 JSON 行跳过（容错）。
- 写入用 `appendFileSync`（与 re-pi 一致，日志量小，同步写足够，不引入异步队列）。`appendFileSync` 每次独立写盘、无持久句柄，因此 `SessionStore` 无需 `close()`。

### 3.2 `ContextCompactor` 改造

保留大结果转存能力，移除「写全量快照」能力：

| 方法 | 改动 |
|------|------|
| `writeTranscript` | 删除 |
| `transcriptDir` 字段 | 删除；构造函数参数改为 `{ provider, toolResultsDir }` |
| `snipCompact` | 删除 `writeTranscript` 调用；marker 从 `[N messages archived at <path>]` 改为 `[N messages archived]` |
| `isArchiveMarker` | 从「路径 + 文件存在检查」改为纯正则 `^\[\d+ messages archived\]$` |
| `compactHistory` | 删除 `writeTranscript` 与 `log.info("transcript saved")` |
| `reactiveCompact` | 删除 `writeTranscript` 与 `log.info("transcript saved")` |
| `summaryMessage` | 去掉 `transcript` 参数与 `Full transcript: ...` 行；只保留 label / request / summary |
| `toolResultBudget` / `microCompact` / `fitToolResults` / `persistLargeOutput` / `saveOutput` / `persistedPreview` / `persistedOutputPath` | 全部保留不动 |

> `summaryMessage` 去掉 `Full transcript` 字段的理由：模型不会主动读该文件，留档本身就是 `.sessions/` 里的完整对话；去掉后 compactor 无需感知 session 文件路径，边界更干净。

### 3.3 消息 append 挂载点

`Harness` 新增 `readonly sessionStore?: SessionStore`，`agentLoop` 通过 `harness.sessionStore` 访问。append 只在「push 新消息」时发生，压缩（`prepare` 的 splice 替换）不触发 append，因此文件永远是完整原始对话、内存永远是精简对话，二者天然解耦。

| 位置 | 动作 |
|------|------|
| `harness.runTurn` 第 80 行 push user 消息后 | `this.sessionStore?.append(userMsg)` |
| `agentLoop` 第 68 行 push assistant 消息后 | `harness.sessionStore?.append(message)` |
| `agentLoop` 第 73 行 push goal reminder 后 | `harness.sessionStore?.append(reminder)` |
| `agentLoop` 第 116 行 push tool 消息后 | `harness.sessionStore?.append(toolMsg)` |

**文件内容约定**：只存 user / assistant / tool 三类消息，**不含 system**。system 每次启动由 `newSession()` 重新生成（含最新 memory 段），`--continue` 恢复时拼回队首。

### 3.4 `--continue` 恢复流程

1. `parseCliArgs` 新增 `--continue`（无值 = 恢复最新，`--continue <文件名>` = 指定文件）。
2. REPL 启动时：
   - 有 `--continue`：`file = 指定名 ?? SessionStore.latest(workdir)`；`store = SessionStore.open(file)`；`messages = [newSession()[0], ...SessionStore.load(file)]`。
   - 无 `--continue`：`store = SessionStore.create(workdir)`；`messages = newSession()`。
3. 把 `messages` 传给 `repl(agent, io, messages)`，后续 append 继续写同一个文件。

### 3.5 `-p` 单次模式

不持久化：`buildHarness` 不传 `sessionStore`（`undefined`），`runTurn` / `agentLoop` 里的 `?.append` 全部空转。行为与现状一致。

## 4. 数据流

```
REPL 启动
  ├─ 无 --continue：create 新文件 + newSession()
  └─ 有 --continue：open 最新/指定文件 + load 历史 + 拼 system 队首

每条消息产生 ──▶ append 到 .sessions/session_<now>.jsonl（增量，无重复）
                    │
压缩 prepare ──────┘  只在内存 splice 替换（marker / 摘要），不写文件

--continue 下次启动：读文件全量 → 内存恢复 → prepare 自动重压
```

## 5. 配置与 CLI

- 移除 `transcriptDir`（`.transcripts`），新增 `sessionsDir`（`.sessions`）。
- `main.ts`：
  - `parseCliArgs` 新增 `--continue`：无值 = 恢复最新，有值 = 指定文件名。因 Node `parseArgs` 对「可选值」支持不佳，实现时手动扫描 `argv` 解析该参数（具体见实现计划）。
  - `buildHarness` 新增可选参数 `sessionStore?: SessionStore`，传给 `Harness`。
  - `main()` 里 REPL 分支按 3.4 创建 store 与 messages，`-p` 分支不创建。
- `USAGE` 帮助文本新增 `--continue` 说明。
- `.gitignore` 确认 `.sessions/` 已忽略（与现有 `.transcripts/`、`.task_outputs/` 同类，如未忽略则补充）。

## 6. 测试策略

- 新增 `test/session/store.test.ts`：`create` / `open` / `append` / `load` / `latest` / 空文件容错 / 非法行跳过。
- 改 `test/compaction/compactor.test.ts`：
  - 删除 `writeTranscript` 相关断言。
  - `snipCompact` marker 断言改为 `[N messages archived]`。
  - `isArchiveMarker` 改为正则匹配断言。
  - `compactHistory` / `reactiveCompact` 不再产生 transcript 文件。
  - `summaryMessage` 断言去掉 `Full transcript` 行。
- 改 `test/cli/main.test.ts`：`--continue` 参数解析（无值 / 带值 / 不带）。
- 新增/改 harness/loop 测试：注入 fake `sessionStore`，断言 push 时 `append` 被调用、压缩时不调用。

### 6.1 冒烟测试（真实落盘，`test/integration/session.test.ts`）

用 `MockProvider`（脚本化 LLM 响应）+ 真实临时目录，走完整 `Harness.runTurn` → `agentLoop` 链路，**只 mock LLM，文件 I/O 与压缩流程全部真实**。覆盖三条：

1. **append 真实落盘**：多轮对话后，`.sessions/` 有且仅有一个 session 文件；文件内容按序含全部 user / assistant / tool 消息（不含 system），且无重复。
2. **压缩不写快照**：驱动会话累积超过 50 条消息触发 `snipCompact`，断言 `.sessions/` 仍只有原文件（无新快照）、`.transcripts/` 目录不再产生任何新文件、内存 messages 出现 `[N messages archived]` marker。
3. **--continue 恢复续写**：`SessionStore.latest` + `load` 读回的历史与已 append 内容一致，再 `open` 续写新消息成功、仍落回同一文件。

`test/integration/live.test.ts` 扩展：`BLH_LIVE=1` 时用真实 API 跑一轮，验证 session 文件真实落盘（可选，依赖 API key，默认不跑）。

## 7. 非目标（YAGNI）

- 不引入 re-pi 的 `parentId` 会话树、分支切换、`branch_summary`。
- 不做 session 恢复回放的可视化/搜索界面。
- 不做压缩摘要落盘与增量摘要（`previousSummary` 合并）。
- 不改变 `.task_outputs/tool-results/` 大结果转存行为。
- 不处理 `.transcripts/` 旧快照文件的迁移或清理（保留不动）。
