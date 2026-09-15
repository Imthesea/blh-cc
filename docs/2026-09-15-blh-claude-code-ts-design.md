# blh-claude-code TypeScript 重构方案

- **日期**:2026-09-15
- **状态**:方案待批准
- **源项目**:`F:\allProject\myProject\blh-claude-code`(Python 3.11+,src/blh 约 4100 行,13 个功能包 + 镜像测试)
- **源设计文档**:`blh-claude-code/docs/2026-09-13-blh-claude-code-design.md` 及 M1–M6 各模块设计文档

---

## 1. 背景与目标

将 Python 版 `blh-claude-code`(基于 OpenAI 兼容接口的编码 Agent CLI,命令名 `blh`)**1:1 重构为 TypeScript 版本**。功能、行为、模型契约(工具名/参数/消息格式/持久化文件格式)与 Python 版完全一致;语言级实现(线程模型、异步原语、类型系统)按 TypeScript/Node.js 习惯重写。

**重构而非移植的原则:**

1. **行为对齐**:以 Python 版设计文档与测试为验收基准,模型可见的一切(工具 schema、hook 事件名、通知格式、`.tasks/`、`.memory/`、`.mailboxes/` 等文件格式)不变。
2. **实现换血**:Python 的 daemon 线程 + `threading.Lock` 模型替换为 Node 单线程事件循环 + 显式异步互斥;同步阻塞 I/O 全部改为 `async/await`。
3. **无全局状态**:沿用 Python 版"显式 Harness 持有全部状态"的决策,实例化多个 Harness 互不干扰。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 目标产物 | 可实际使用的 Agent CLI 产品(npm 包,`npx` / 全局安装可用) |
| 运行时 | Node.js >= 20(LTS,原生 fetch / `node:test` 生态基线) |
| 语言 | TypeScript 5.x,`strict: true`,ESM(`"type": "module"`,NodeNext 解析) |
| 模型接口 | 仅 OpenAI 兼容接口,沿用 `openai` npm SDK(与 Python 版同一官方 SDK) |
| 功能范围 | 全量对齐 Python 版 M0–M6,一次到位 |
| 模块边界 | 13 个功能包 1:1 映射,包间依赖规则不变(功能域间禁止直接 import,走 hook/工具池) |
| 命名 | 内部代码 camelCase;**模型可见契约保持 snake_case**(工具参数 `old_text`/`blocked_by`、文件名、消息字段)——这是与模型的协议,不随语言换 |
| 命令名 / 包名 | CLI 命令 `blh`,npm 包名 `blh-claude-code` |
| 并发模型 | Node 事件循环 + `AsyncMutex` 互斥(替换 Python 线程 + Lock);**不引入 worker_threads** |

## 3. 技术栈映射

| 领域 | Python 版 | TS 版 | 说明 |
|---|---|---|---|
| 模型 SDK | `openai>=1.40` | `openai`(npm) | 同一官方 SDK,`chat.completions.create` 参数一致 |
| 环境变量 | `python-dotenv` | `dotenv` | `.env` 加载,已存在环境变量优先 |
| YAML | `PyYAML` | `yaml` | 配置文件与 memory frontmatter,`parse`/`stringify` 对应 `safe_load`/`safe_dump` |
| CLI 参数 | `argparse`(标准库) | `node:util` 的 `parseArgs`(标准库) | 零新依赖 |
| glob 匹配 | `pathlib.Path.glob` / `fnmatch` | `fast-glob`(文件遍历)+ 手写 `fnmatch`(权限规则,约 15 行) | `minimatch` 的 `*` 不跨 `/`,与 Python fnmatch 语义不一致,故权限匹配手写 |
| 子进程 | `subprocess.run` | `node:child_process`(`execFile`/`spawn` promisify) | bash 工具与后台任务 |
| 线程/锁 | `threading` daemon + `Lock`/`RLock`/`Condition` | `setInterval` 轮询 + 自研 `AsyncMutex`(Promise 链) | 见 §5 |
| 测试 | `pytest` | `vitest` | `describe/it/expect`,默认排除 `live` 标记用例 |
| Lint | `ruff` | `eslint` + `@typescript-eslint` | CI 同跑 |
| 打包 | `setuptools` + `pyproject.toml` | `tsc` 产物 + `package.json` `bin` 字段 | `dist/` 输出,`bin/blh.js` 入口 |
| 开发运行 | `uv run blh` | `tsx src/cli/main.ts` | `tsx` 为 devDependency |

**运行时依赖**(对齐 Python 版 3 个依赖的规模,不膨胀):

```json
{
  "openai": "^4",
  "dotenv": "^16",
  "yaml": "^2",
  "fast-glob": "^3"
}
```

**开发依赖**:`typescript`、`tsx`、`vitest`、`eslint`、`@typescript-eslint/parser`、`@typescript-eslint/eslint-plugin`、`@types/node`。

## 4. 整体架构与包结构

四层结构与包划分**完全沿用 Python 版**(每层只依赖下层;功能域向核心注册"工具 + hook 监听 + 系统提示词片段";功能域间禁止直接 import):

```
blh-claude-code-ts/
  package.json              # ESM,bin: blh → dist/cli/main.js
  tsconfig.json             # strict, NodeNext, outDir: dist
  src/
    cli/         main.ts        # parseArgs 入口 + buildHarness 装配
                 repl.ts        # 交互循环(readline)
    core/        types.ts       # OpenAI 消息/工具调用类型(全项目共享)
                 mutex.ts       # AsyncMutex(替换 Python threading.Lock)
                 config.ts      # 四层优先级配置加载
                 hooks.ts       # HookBus
                 harness.ts     # Harness:装配部件,驱动单轮
                 loop.ts        # agentLoop 主循环
    providers/   openai.ts      # OpenAIProvider:chat(messages, tools, maxTokens?)
                 retry.ts       # 指数退避 + Retry-After + 抖动
    tools/       registry.ts    # Tool 接口 + ToolRegistry(schemas/dispatch)
                 bash.ts files.ts glob.ts index.ts   # 5 个内置工具
    security/    rules.ts       # PermissionRule + 匹配
                 approval.ts    # PreToolUse 权限 hook 工厂
    compaction/  compactor.ts tools.ts      # 四步压缩管线 + compact 工具
    memory/      store.ts text.ts recall.ts extract.ts system.ts
    planning/    todo.ts tasks.ts tools.ts
    jobs/        background.ts cron.ts runtime.ts tools.ts
    agents/      subagent.ts bus.ts worktree.ts teammate.ts team.ts tools.ts
    extensions/  skills.ts mcp.ts tools.ts
    workflow/    schema.ts journal.ts runtime.ts tool.ts registry.ts tools.ts
    goals/       types.ts transcript.ts evaluator.ts controller.ts
  tests/         # vitest,镜像 src 结构
  docs/
```

与 Python 版文件级 1:1 对应,仅 `__init__.py` 的注册函数移入各包 `tools.ts` / `index.ts`。测试同样镜像。

## 5. 关键架构适配(Python → TS)

### 5.1 全面 async 化

Python 版 `agent_loop` 是同步的;TS 版 provider 调用、工具 handler、hook 回调**全部 `async`**:

```typescript
// src/core/types.ts —— 全项目共享的模型契约类型
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolSchema[], maxTokens?: number): Promise<ChatMessage>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;
```

`ToolRegistry.dispatch`、`HookBus.trigger/firstBlock`、所有内置工具 handler 均为 `Promise<string>`。这消除了 Python 版 `run_workflow_sync = asyncio.run(...)` 的桥接——workflow 的异步原语在 TS 里是原生的。

### 5.2 线程模型 → 事件循环 + AsyncMutex

Python 版用三条 daemon 线程(cron-scheduler / cron-queue-processor / lead-inbox-processor)+ teammate 线程 + `agent_lock` 互斥访问 `messages`。TS 版替换为:

| Python | TS |
|---|---|
| cron-scheduler 线程(每秒 poll) | `setInterval(pollDue, 1000)`,到期任务入内存队列 |
| cron-queue-processor 线程(0.2s) | `setInterval(processQueue, 200)` |
| lead-inbox-processor 线程(0.2s) | `setInterval(processLeadInbox, 200)` |
| teammate daemon 线程 ×N | 每个 teammate 一个并发 `async` WORK/IDLE 循环任务 |
| `threading.Lock` agent_lock | `AsyncMutex`(`src/core/mutex.ts`):`runExclusive(fn)` 用 Promise 链串行化 |
| `acquire(blocking=False)` 抢不到跳过 | `tryRunExclusive(fn)`:mutex 被占时直接返回 `false` |
| `threading.Condition`(MessageBus IDLE 等待) | `Deferred` +  waiter 队列(`waiters: Array<() => void>`) |

`AsyncMutex` 自研约 20 行,零依赖:

```typescript
// src/core/mutex.ts
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.tail.then(fn);
    this.tail = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.pending--;
    }
  }

  /** 对应 Python 的 acquire(blocking=False):占锁时跳过,返回 undefined */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.pending > 0) return undefined;
    return this.runExclusive(fn);
  }
}
```

**单线程红利**:Node 单线程事件循环下,同步代码块天然原子——Python 版 `TaskStore.claim` 的 `RLock`、`MessageBus` 的锁在同步临界区内不再需要,只在跨 `await` 的临界区用 `AsyncMutex`。

### 5.3 审批线程判定 → 显式交互上下文

Python 版用 `threading.current_thread() is threading.main_thread()` 区分"可交互审批的用户回合"与"cron/团队回合"。Node 无线程概念,改为**显式上下文标记**:

```typescript
// src/security/approval.ts
export type TurnKind = "interactive" | "scheduled";

export function makePermissionHook(
  rules: PermissionRule[],
  workdir: string,
  askFn: (prompt: string) => Promise<string>,
  getTurnKind: () => TurnKind,   // 由 Harness 注入,返回当前回合类型
): PreToolUseHook {
  return async (event) => {
    const target = event.input.command ?? event.input.path ?? "";
    const action = matchRule(rules, event.name, target);
    if (action === "allow") return null;
    if (action === "deny") return `denied by permission rule (${event.name}: ${target})`;
    if (getTurnKind() !== "interactive") {
      return "denied: cannot request approval from a scheduled turn";
    }
    const answer = await askFn(`allow ${event.name}(${target})? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim()) ? null : "denied by user";
  };
}
```

Harness 持有 `currentTurnKind` 字段:`runTurn`(用户)置 `interactive`,`runScheduledTurn`/`runTeamTurn` 置 `scheduled`,回合结束复位。语义与 Python 版一致,且比线程判定更显式。

### 5.4 其余逐项映射

| 主题 | Python 版 | TS 版 |
|---|---|---|
| 消息内部表示 | `list[dict]`(OpenAI 格式) | `ChatMessage[]`(同格式,加类型) |
| bash 执行 | `subprocess.run(shell=True)` | `exec` promisify(`{ cwd, timeout, maxBuffer, shell }`),Windows/Unix 兼容 |
| 后台任务 | daemon 线程 + `subprocess.run` | `spawn` + 完成回调推入完成队列,`injectBackgroundResults` 在下次 `provider.chat` 前消费 |
| 原子写 | 临时文件 + `os.replace` | 临时文件 + `fs.rename` |
| 排他分配 ID | `open("x")` | `fs.open(path, "wx")` |
| cron ID | `secrets.token_hex(4)` | `crypto.randomBytes(4).toString("hex")` |
| git worktree | `subprocess.run(["git", ...])` | `execFile("git", [...])`(数组参数,无 shell 插值) |
| MCP stdio | `Popen` 管道 + NDJSON | `spawn` + `readline` 按行解析 JSON-RPC |
| workflow 并发上限 | `asyncio.Semaphore(8)` | 自研 `Semaphore` 类(acquire/release + waiter 队列,约 30 行) |
| 稳定 hash | `int(sha256(s).hexdigest(), 16) % 10**10` | `createHash("sha256")` 取前 12 位 hex 转 number 后 `% 1e10`(避免 BigInt,精度足够) |
| REPL 输入 | `input()` | `node:readline` |
| 路径沙箱 | `pathlib` resolve + parents 检查 | `path.resolve` + 前缀检查(统一 `path.sep` 与大小写规范) |

## 6. 逐模块移植要点

### M0 骨架与最小闭环(core / providers / tools / security / cli)

- **`core/hooks.ts`**:`HookBus` 直接翻译(`register/trigger/firstBlock`,全部 async,`firstBlock` 返回首个非 null)。
- **`core/loop.ts`**:`agentLoop(harness, messages): Promise<void>`——`provider.chat` → 无 `tool_calls` 返回;有则逐 call `firstBlock(PRE_TOOL_USE)` → `dispatch` → 追加 `role=tool`。纯翻译。
- **`tools/*`**:5 个内置工具(handler 返回 `Promise<string>`);`safePath` 沙箱逻辑不变。
- **`security/rules.ts`**:`fnmatch.fnmatch` → `minimatch(target, pattern)`;`DEFAULT_RULES` 内容不变。
- **`providers/retry.ts`**:`retryAfterSeconds` 从 `error.headers?.["retry-after"]` 读(openai npm SDK 的错误对象带 `status` 与 `headers`);`isRetryable` 读 `error.status`;抖动 `base * (0.5 + Math.random())` 封顶 32s。
- **`cli/repl.ts`**:`readline` 逐行读,`exit`/`quit`/EOF 退出。

### M1 上下文与规划(compaction / planning / memory)

- **compaction**:四步管线(`prepare`:tool_result_budget → snip → micro → fit_tool_results → compact_history)、反应式压缩(400 + 错误体关键词 `isPromptTooLong`)、`compact` 工具拦截,全部直译。token 估算沿用字符估算。`.transcripts/`、`.task_outputs/tool-results/` 落盘格式不变。
- **planning**:todo 清单(整表替换 + 连续 3 轮未更新 reminder 追加到本批最后一条 `role=tool` content)+ 任务图(`.tasks/{id}.json`,`blocked_by` 依赖、环检测、owner 认领)。持久化 JSON 格式不变,`task_{8位hex}` ID 用 `fs.open(wx)` 排他分配。
- **memory**:`.memory/*.md`(YAML frontmatter)+ `MEMORY.md` 索引;召回(模型选择 + 关键词降级)、提取(scope/临时性/重复三重过滤)、整理(阈值合并 + 快照回滚)。`yaml` 包读写 frontmatter。三个子系统均由 Harness 自动运行,不暴露工具——不变。

### M2 异步与调度(jobs)

- bash 增加 `run_in_background` 参数;`BackgroundManager` 用 `spawn` 异步执行,完成回调入队,下轮模型调用前以 `<task_notification>` 注入 user 消息。`bg_0001` 计数格式不变。
- cron:五段式表达式纯函数(`validateCron`/`cronMatches`)直译;`setInterval` 替换两条调度线程(§5.2);`.scheduled_tasks.json` 原子写 + 损坏跳过;at-least-once 语义(ack 在回合正常结束后,失败恢复队列重新交付)不变。
- 调度线程只在 REPL 启动(`-p` 一次性模式不启动)——不变。`JobsRuntime.start()/stop()` 幂等,`stop()` 清 interval 并等当前回合收尾(带 1s 超时)。

### M3 多智能体(agents)

- **subagent**(`task` 工具):同步嵌套 loop → `await subagentRunner.run(prompt)`,30 轮上限、仅 5 个基础工具、无二次委派——直译。
- **团队**:teammate 线程 → 并发 async 循环(§5.2);`MessageBus`(`.mailboxes/<name>.jsonl` 读即删)用 waiter 队列替换 `Condition`;共享任务板认领在单线程下同步代码天然原子,跨进程原子认领仍为非目标;worktree 用 `execFile("git", ...)`;plan gate / shutdown 协议状态机直译。
- 队友不能跑 `bash`(非交互回合审批拒绝)的安全模型不变(§5.3)。

### M4 扩展能力(extensions)

- **skills**:`workdir/skills/*/SKILL.md` 扫描,frontmatter 解析,catalog/load——直译。
- **MCP**:自实现 JSON-RPC over stdio(不引入 MCP SDK)——`spawn` 子进程,`readline` 按行 `JSON.parse`,按 `id` 匹配响应,读响应带超时;`initialize` → `notifications/initialized` → `tools/list` → 注册 `mcp__{server}__{tool}`;命名归一化(`[^a-zA-Z0-9_-]` → `_`,64 字符上限,碰撞报错)不变;权限兜底规则 `mcp__* → ask`、`connect_mcp → ask` 不变。

### M5 编排与目标闭环(workflow / goals)

- **workflow**:`SimpleJsonSchema` 校验、`WorkflowJournal`(jsonl,resume 回放缓存,稳定语义 key)、`ExecutionState` 原语(`phase/log/agent/parallel/pipeline/workflow`)、`Budget`、`AGENT_CAP=1000`/`CONCURRENCY=8`。Python 版保留 asyncio 原语 + `asyncio.run` 桥接;TS 版天然 async,删掉桥接层,`run_workflow` 工具 handler 直接 `await`。
- **goals**:transcript 渲染(按 role 格式化 + 截断)、`PromptGoalEvaluator`(无 tools 单轮 chat,严格解析 `{ok, reason, impossible}`)、`GoalController`(六种 StopDecision:`allow/defer/achieved/failed/limit/block`,`blockCap=8`)。loop 在 `block` 时追加 `[Goal still active]` 续行——直译。REPL `/goal` 命令不变。

### M6 打磨与发布

- **配置体系**:四层优先级(内置默认 < 配置文件 < 环境变量 < CLI 参数);用户级 `~/.config/blh/config.yaml` + 项目级 `./.blh.yaml`;键名映射(`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`BLH_MODEL`/`BLH_BASH_TIMEOUT`/`BLH_MAX_OUTPUT_CHARS`)不变;类型转换失败抛 `ConfigError` 指明来源。
- **README / 打包**:`npm publish` 语义对齐 PyPI 发布(本里程碑只验证 `npm pack` 产物可全局安装,不执行真实 publish)。

## 7. 里程碑与验收

每个里程碑结束保持可运行,验收标准与 Python 版逐项对齐:

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0 骨架与最小闭环** | package 骨架、`providers`、`core`、`tools` + 5 个内置工具、`security`、`cli`(REPL + `-p`) | 能对话、执行工具、权限审批生效;`vitest` 全绿 |
| **M1 上下文与规划** | `compaction`、`planning`、`memory` | 长对话自动压缩;任务可依赖/持久化;记忆可存取 |
| **M2 异步与调度** | `jobs` | 后台执行不阻塞;cron 到点注入 |
| **M3 多智能体** | `agents` | subagent 隔离返回;多 teammate 协同认领 |
| **M4 扩展能力** | `extensions` | load_skill 生效;接入真实 MCP server |
| **M5 编排与目标闭环** | `workflow`、`goals` | 工作流断点恢复;评估器控制停止/续行 |
| **M6 打磨与发布** | 配置体系、错误恢复、README、npm 打包 | `npm pack` + 全局安装后 `blh --help` 可用 |

**实施顺序与依赖**:M0 → M1 → M2 → M3(依赖 M1 的 TaskStore、M2 的 agentLock)→ M4 → M5(依赖 M2 的后台状态)→ M6。每个里程碑开始前,参照 Python 版 `docs/plans/` 对应计划编写 TS 版细粒度实施计划(TDD,任务拆到 2–5 分钟步长)。

## 8. 测试策略

- **单元测试**:每包独立 vitest 文件,mock provider(`MockProvider` 脚本化返回预定 `tool_calls`,从 Python 版测试直接改写);`tests/` 镜像 `src/` 结构。
- **用例复用**:Python 版 `tests/` 全部用例按新结构改写适配(压缩配对、cron 解析、权限、任务系统、总线、worktree、journal、评估器等),**移植测试逻辑,不重写**。
- **集成测试**:`MockProvider` 驱动完整 loop 闭环(写文件 → 读回 → 文本回复),不依赖真实 API。
- **真实 API 冒烟**:标记 `live`,默认跳过(`vitest` 用 `--exclude` 或 tag 过滤),手动触发。
- **类型检查**:`tsc --noEmit` 纳入验证命令,等价于 Python 版 `ruff check`。
- **CI**:GitHub Actions 跑 `eslint` + `tsc --noEmit` + `vitest run`。

## 9. 非目标(Out of Scope)

- 不支持 Anthropic 原生协议、不支持除 OpenAI 兼容接口外的 provider(与 Python 版一致)。
- 不引入 MCP 官方 SDK(自实现 stdio JSON-RPC,与 Python 版决策一致)。
- 不引入 worker_threads / 跨进程文件锁(单进程 CLI,与 Python 版运行边界一致)。
- v1 不做:LSP 集成、IDE 插件、Web UI、浏览器端支持。
- 不做双语言共存/渐进迁移:本仓库是独立 TS 重写,Python 仓库保持不动。
