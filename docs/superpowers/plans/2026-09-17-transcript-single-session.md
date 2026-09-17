# 会话留档优化（全量快照 → 单一会话文件）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除 `ContextCompactor` 的 `writeTranscript` 全量快照，改为 `SessionStore` 单一 JSONL 会话文件持续 append，并支持 `--continue` 续写。

**架构：** 新增 `src/session/store.ts`（`SessionStore`）作为会话文件唯一读写入口；`ContextCompactor` 去掉 `transcriptDir` / `writeTranscript`，压缩只改内存不改文件；`Harness` 新增 `sessionStore` 字段，`agentLoop` 在 push user/assistant/tool 消息时 append；`main.ts` 新增 `--continue`，REPL 恢复历史后续写同一文件。

**技术栈：** TypeScript ESM、Node `node:fs`（`appendFileSync` / `readdirSync` / `readFileSync`）、Vitest。

**规格：** `docs/superpowers/specs/2026-09-17-transcript-single-session-design.md`

---

## 文件结构

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/session/store.ts` | 创建 | `SessionStore`：create/open/latest/load/append |
| `test/session/store.test.ts` | 创建 | `SessionStore` 单元测试 |
| `test/integration/session.test.ts` | 创建 | 冒烟测试（真实落盘） |
| `src/compaction/compactor.ts` | 修改 | 删 `writeTranscript`/`transcriptDir`，marker 与 `summaryMessage` 改造 |
| `src/core/harness.ts` | 修改 | 新增 `sessionStore` 字段 + `runTurn` append |
| `src/core/loop.ts` | 修改 | `agentLoop` 三处 append |
| `src/cli/main.ts` | 修改 | `--continue` 解析 + REPL 恢复/创建 store |
| `src/cli/repl.ts` | 修改 | `repl` 接受 `initialMessages` |
| `test/compaction/compactor.test.ts` | 修改 | 移除 transcript 断言，改 marker/摘要断言 |
| `test/core/loop.test.ts` | 修改 | 改 `makeCompactor`，改 `.transcripts` 断言，新增 append 测试 |
| `test/cli/main.test.ts` | 修改 | 改 `transcriptDir` 断言，新增 `--continue` 解析测试 |
| `.gitignore` | 修改 | 新增 `.sessions/` |

---

## 实现说明（相对规格的少量细化）

- **`Harness.sessionStore` 为可变字段（非 readonly）**：因为 `.sessions/` 必须落在 `buildHarness` 内部解析出的 `config.workdir` 下，而 store 又必须在 `runTurn` 前就位。若做成构造参数（readonly），`main()` 会与 `buildHarness` 的 `loadConfig` 形成「先有鸡还是先有蛋」的循环。因此 `main()` 先 `buildHarness`，再读 `harness.config.workdir` 创建 store 并赋值 `harness.sessionStore = store`。字段类型仍是 `SessionStore | undefined`，`-p` 模式不赋值即为 `undefined`。
- **`latest` 目录不存在时返回 `null`（不主动 mkdir）**：`--continue` 无可用会话时直接报错退出，语义更清晰。`create` 负责 `mkdirSync`。

---

## 任务 1：SessionStore（新文件 + 单元测试）

**文件：**
- 创建：`src/session/store.ts`
- 测试：`test/session/store.test.ts`
- 修改：`.gitignore`

- [ ] **步骤 1：编写失败的测试**

创建 `test/session/store.test.ts`：

```ts
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/session/store.js";
import type { ChatMessage } from "../../src/core/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "session-store-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("create 在 .sessions/ 下新建 session_<timestamp>.jsonl", () => {
    const store = SessionStore.create(tmpDir);
    expect(store.path.startsWith(path.join(tmpDir, ".sessions", "session_"))).toBe(true);
    expect(store.path.endsWith(".jsonl")).toBe(true);
    expect(existsSync(store.path)).toBe(true);
  });

  it("append 逐行追加 JSONL", () => {
    const store = SessionStore.create(tmpDir);
    store.append({ role: "user", content: "hello" });
    store.append({ role: "assistant", content: "hi" });
    const lines = readFileSync(store.path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ role: "user", content: "hello" });
    expect(JSON.parse(lines[1]!)).toEqual({ role: "assistant", content: "hi" });
  });

  it("load 还原消息数组并跳过空行与非法行", () => {
    const store = SessionStore.create(tmpDir);
    appendFileSync(store.path, '{"role":"user","content":"a"}\n', "utf8");
    appendFileSync(store.path, "\n", "utf8");
    appendFileSync(store.path, "not-json\n", "utf8");
    appendFileSync(store.path, '{"role":"assistant","content":"b"}\n', "utf8");
    const messages = SessionStore.load(store.path);
    expect(messages).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
  });

  it("load 对不存在的文件返回空数组", () => {
    expect(SessionStore.load(path.join(tmpDir, "nope.jsonl"))).toEqual([]);
  });

  it("latest 返回 mtime 最新的 .jsonl，目录为空/缺失时返回 null", () => {
    expect(SessionStore.latest(tmpDir)).toBeNull();
    const older = SessionStore.create(tmpDir);
    const newer = SessionStore.create(tmpDir);
    // 强制让 newer 的 mtime 更晚，规避同毫秒创建的排序不稳定
    writeFileSync(newer.path, '{"role":"user","content":"touch"}\n', "utf8");
    expect(SessionStore.latest(tmpDir)).toBe(newer.path);
    expect(newer.path).not.toBe(older.path);
  });

  it("open 返回指向给定路径的实例", () => {
    const store = SessionStore.open(path.join(tmpDir, "custom.jsonl"));
    expect(store.path).toBe(path.join(tmpDir, "custom.jsonl"));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/session/store.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/session/store.js'`（或 `SessionStore` 未定义）。

- [ ] **步骤 3：编写最少实现代码**

创建 `src/session/store.ts`：

```ts
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "../core/types.js";

/** 会话文件的唯一读写入口：单一 JSONL 文件持续 append，与压缩解耦。 */
export class SessionStore {
  private constructor(readonly path: string) {}

  static sessionsDir(workdir: string): string {
    return path.join(workdir, ".sessions");
  }

  /** 新建 .sessions/session_<now>.jsonl，返回持有该文件的实例。 */
  static create(workdir: string): SessionStore {
    const dir = SessionStore.sessionsDir(workdir);
    mkdirSync(dir, { recursive: true });
    return new SessionStore(path.join(dir, `session_${Date.now()}.jsonl`));
  }

  /** 打开已有文件（append 模式；appendFileSync 无持久句柄，无需 close）。 */
  static open(filePath: string): SessionStore {
    return new SessionStore(filePath);
  }

  /** 返回 .sessions/ 下 mtime 最新的 .jsonl 路径；无则 null。 */
  static latest(workdir: string): string | null {
    const dir = SessionStore.sessionsDir(workdir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const files = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });
    if (files.length === 0) return null;
    files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0]!;
  }

  /** 逐行 JSON.parse 还原消息数组；空行 / 非法 JSON 行跳过。 */
  static load(filePath: string): ChatMessage[] {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        messages.push(JSON.parse(line) as ChatMessage);
      } catch {
        // 容错：跳过无法解析的行
      }
    }
    return messages;
  }

  /** JSON.stringify + "\n"，appendFileSync 追加。 */
  append(message: ChatMessage): void {
    appendFileSync(this.path, JSON.stringify(message) + "\n", "utf8");
  }
}
```

在 `.gitignore` 末尾追加：

```gitignore
.sessions/
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/session/store.test.ts`
预期：PASS（7 条用例全绿）。

- [ ] **步骤 5：Commit**

```bash
git add src/session/store.ts test/session/store.test.ts .gitignore
git commit -m "feat: add SessionStore single-file session persistence"
```

---

## 任务 2：ContextCompactor 移除 transcript 快照

> 本任务会同时改动 `compactor.ts` 的构造函数签名，因此必须连带更新其调用方（`loop.test.ts` 的 `makeCompactor`、`main.ts` 的 `buildHarness`、`main.test.ts` 的断言）才能保持编译通过。

**文件：**
- 修改：`src/compaction/compactor.ts`
- 修改：`test/compaction/compactor.test.ts`
- 修改：`test/core/loop.test.ts`（`makeCompactor` 与 `.transcripts` 断言）
- 修改：`src/cli/main.ts`（`buildHarness` 中 compactor 构造）
- 修改：`test/cli/main.test.ts`（`transcriptDir` 断言）

- [ ] **步骤 1：改造测试**

`test/compaction/compactor.test.ts` 做以下改动：

1. `makeCompactor` 去掉 `transcriptDir`：

```ts
function makeCompactor(tmpDir: string, provider?: ChatProvider): ContextCompactor {
  return new ContextCompactor({
    provider: provider ?? new FakeProvider([]),
    toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
  });
}
```

2. 删除整个 `writeTranscript` 测试（原第 142-150 行）。

3. 在「消息判定原语」describe 中新增 `isArchiveMarker` 测试：

```ts
it("isArchiveMarker 仅匹配 [N messages archived]", () => {
  const compactor = makeCompactor(tmpDir);
  expect(compactor.isArchiveMarker(userMsg("[5 messages archived]"))).toBe(true);
  expect(compactor.isArchiveMarker(userMsg("[5 messages archived at /tmp/x]"))).toBe(false);
  expect(compactor.isArchiveMarker(userMsg("not a marker"))).toBe(false);
});
```

4. 重写 `snipCompact 归档完整历史并可幂等` 测试为：

```ts
it("snipCompact 归档完整历史并生成纯标记（无文件）", () => {
  const compactor = makeCompactor(tmpDir);
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 9; i++) {
    messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` });
  }
  const compacted = compactor.snipCompact([...messages], 6);
  expect(compacted).toHaveLength(6);
  expect(compacted[3]?.content).toBe("[5 messages archived]");
  expect(compactor.snipCompact([...compacted], 6)).toEqual(compacted);
});
```

5. 重写 `compactHistory 返回单条摘要消息并留档 transcript` 测试为：

```ts
it("compactHistory 返回单条摘要消息且不落盘 transcript", async () => {
  const provider = new FakeProvider([{ role: "assistant", content: "the summary" }]);
  const compactor = makeCompactor(tmpDir, provider);
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    userMsg("old work"),
  ];
  const compacted = await compactor.compactHistory(messages, "fix the bug");
  expect(compacted).toHaveLength(1);
  expect(compacted[0]?.role).toBe("user");
  const content = compacted[0]?.content ?? "";
  expect(content.startsWith("[Compacted]")).toBe(true);
  expect(content).toContain("Current user request:\nfix the bug");
  expect(content).toContain("the summary");
  expect(content).not.toContain("Full transcript:");
  expect(existsSync(path.join(tmpDir, ".transcripts"))).toBe(false);
});
```

6. 两个 `reactiveCompact` 测试中删除 `compactor.writeTranscript = () => "transcript.jsonl";` 这一行（各一处），其余断言保持不变。

`test/core/loop.test.ts` 做以下改动：

1. `makeCompactor` 去掉 `transcriptDir`：

```ts
function makeCompactor(tmpDir: string, provider?: ChatProvider): ContextCompactor {
  return new ContextCompactor({
    provider: provider ?? new MockProvider([]),
    toolResultsDir: path.join(tmpDir, ".task_outputs", "tool-results"),
  });
}
```

2. `compact 工具在批次闭合后压缩` 测试末尾的 `.transcripts` 断言替换为：

```ts
expect(messages[1]?.content).not.toContain("Full transcript:");
expect(existsSync(path.join(tmpDir, ".transcripts"))).toBe(false);
```

同时把文件顶部 `import { mkdtempSync, readdirSync, rmSync } from "node:fs";` 改为 `import { existsSync, mkdtempSync, rmSync } from "node:fs";`（`readdirSync` 不再使用）。

`test/cli/main.test.ts` 中 `compactor 与 compact 工具就位` 测试改为（去掉 `transcriptDir` 断言）：

```ts
it("compactor 与 compact 工具就位", async () => {
  const { buildHarness } = await import("../../src/cli/main.js");
  const harness = buildHarness(tmpDir);
  expect(harness.compactor?.toolResultsDir).toBe(
    path.join(tmpDir, ".task_outputs", "tool-results"),
  );
  expect(harness.tools.list().map((tool) => tool.name)).toContain("compact");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/compaction/compactor.test.ts test/core/loop.test.ts test/cli/main.test.ts`
预期：FAIL，`transcriptDir` 不存在于 `CompactorOptions` / marker 仍是旧格式 / 仍写 `.transcripts` 等编译或断言错误。

- [ ] **步骤 3：改造实现**

`src/compaction/compactor.ts`：

1. 删除 `import { randomUUID } from "node:crypto";`（第 1 行）。
2. `CompactorOptions` 去掉 `transcriptDir`：

```ts
export interface CompactorOptions {
  provider: ChatProvider;
  toolResultsDir: string;
}
```

3. 类字段与构造函数去掉 `transcriptDir`：

```ts
readonly provider: ChatProvider;
readonly toolResultsDir: string;

contextCharLimit: number = ContextCompactor.CONTEXT_CHAR_LIMIT;

constructor(options: CompactorOptions) {
  this.provider = options.provider;
  this.toolResultsDir = options.toolResultsDir;
}
```

4. 删除 `writeTranscript` 方法（原第 81-90 行）。

5. `isArchiveMarker` 改为纯正则：

```ts
isArchiveMarker(message: ChatMessage): boolean {
  return message.content !== null && /^\[\d+ messages archived\]$/.test(message.content);
}
```

6. `snipCompact` 删除 `writeTranscript` 调用，marker 改为纯标记：

```ts
const marker: ChatMessage = {
  role: "user",
  content: `[${tailStart - headEnd} messages archived]`,
};
return [...messages.slice(0, headEnd), marker, ...messages.slice(tailStart)];
```

7. `summaryMessage` 去掉 `transcript` 参数与 `Full transcript` 行：

```ts
static summaryMessage(label: string, request: string, summary: string): ChatMessage {
  return {
    role: "user",
    content:
      `[${label}]\n\nCurrent user request:\n${request}\n\n` +
      `Conversation summary (reference only):\n${JSON.stringify(summary)}`,
  };
}
```

8. `compactHistory` 去掉写盘与日志：

```ts
async compactHistory(messages: ChatMessage[], activeRequest: string): Promise<ChatMessage[]> {
  const summary = await this.summarizeHistory(messages);
  return [ContextCompactor.summaryMessage("Compacted", activeRequest, summary)];
}
```

9. `reactiveCompact` 去掉写盘与日志，去掉 `transcript` 实参：

```ts
const message = ContextCompactor.summaryMessage("Reactive compact", activeRequest, summary);
```

（其余 `toolResultBudget` / `microCompact` / `fitToolResults` / `persistLargeOutput` / `saveOutput` / `persistedPreview` / `persistedOutputPath` / `isInsideDir` / `isFile` 保持不变。）

`src/cli/main.ts` 的 `buildHarness` 中 compactor 构造去掉 `transcriptDir`：

```ts
const compactor = new ContextCompactor({
  provider,
  toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
});
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/compaction/compactor.test.ts test/core/loop.test.ts test/cli/main.test.ts`
预期：PASS。

- [ ] **步骤 5：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误（确认无遗留 `transcriptDir` / `writeTranscript` 引用）。

- [ ] **步骤 6：Commit**

```bash
git add src/compaction/compactor.ts test/compaction/compactor.test.ts test/core/loop.test.ts src/cli/main.ts test/cli/main.test.ts
git commit -m "refactor: remove writeTranscript snapshot from ContextCompactor"
```

---

## 任务 3：Harness + agentLoop append 钩子

**文件：**
- 修改：`src/core/harness.ts`
- 修改：`src/core/loop.ts`
- 测试：`test/core/loop.test.ts`（新增 append 断言）

- [ ] **步骤 1：编写失败的测试**

在 `test/core/loop.test.ts` 的 `agentLoop 压缩集成` describe 中新增两个测试（该 describe 已有 `tmpDir`）：

```ts
it("runTurn 把 user/assistant/tool 追加到 sessionStore", async () => {
  const store = SessionStore.create(tmpDir);
  const harness = makeHarness([
    makeToolCallMessage("echo", { text: "hi" }),
    makeTextMessage("done"),
  ]);
  harness.sessionStore = store;
  const messages = harness.newSession();
  await harness.runTurn(messages, "go");
  expect(SessionStore.load(store.path).map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
});

it("压缩（snipCompact）不向 sessionStore 追加", async () => {
  const store = SessionStore.create(tmpDir);
  const compactor = makeCompactor(tmpDir);
  const harness = makeHarness([makeTextMessage("done")], { compactor });
  harness.sessionStore = store;
  const messages = harness.newSession();
  for (let i = 0; i < 51; i++) messages.push({ role: "user", content: `m${i}` });
  const before = SessionStore.load(store.path).length;
  await harness.runTurn(messages, "trigger");
  const after = SessionStore.load(store.path).length;
  expect(after - before).toBe(2); // 只有 user + assistant，snipCompact 的 marker 不落盘
});
```

并在文件顶部补充 `import { SessionStore } from "../../src/session/store.js";`。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/core/loop.test.ts`
预期：FAIL，`harness.sessionStore` 不存在（类型错误）或 append 未生效。

- [ ] **步骤 3：编写最少实现代码**

`src/core/harness.ts`：

1. 顶部补充 `import type { SessionStore } from "../session/store.js";`。
2. 类字段新增：

```ts
export class Harness {
  readonly systemPrompt: string;
  /** 会话留档入口；仅 REPL 注入，-p 模式为 undefined（不落盘）。 */
  sessionStore?: SessionStore;
```

3. `runTurn` 的 push 处改为先存变量再 append：

```ts
async runTurn(messages: ChatMessage[], text: string): Promise<void> {
  await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
  const userMessage: ChatMessage = { role: "user", content: text };
  messages.push(userMessage);
  this.sessionStore?.append(userMessage);
  const systemMessage = messages[0];
  // ... 其余不变
}
```

`src/core/loop.ts` 三处 push 追加 append：

1. assistant 消息（原第 68 行）：

```ts
messages.push(message);
harness.sessionStore?.append(message);
```

2. goal reminder（原第 73 行）：

```ts
const reminder: ChatMessage = { role: "user", content: goalReminder(harness.goal, decision) };
messages.push(reminder);
harness.sessionStore?.append(reminder);
continue;
```

3. tool 结果（原第 116 行）：

```ts
const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: result };
messages.push(toolMessage);
harness.sessionStore?.append(toolMessage);
```

> 说明：`todoManager.noteRound` 是在 tool 消息 push **之后**原地修改 `last.content`，因此会话文件中的 tool 内容不含 todo 提醒（提醒由 todo 状态即时生成，不依赖历史），符合规格「append 只在 push 时发生」。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/core/loop.test.ts test/core/harness.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/core/harness.ts src/core/loop.ts test/core/loop.test.ts
git commit -m "feat: append session messages from harness and agent loop"
```

---

## 任务 4：--continue CLI 与 repl 初始消息

**文件：**
- 修改：`src/cli/main.ts`
- 修改：`src/cli/repl.ts`
- 测试：`test/cli/main.test.ts`（`--continue` 解析）

- [ ] **步骤 1：编写失败的测试**

在 `test/cli/main.test.ts` 的 `parseCliArgs` describe 中新增：

```ts
it("parses --continue with no value (restore latest)", async () => {
  const { parseCliArgs } = await import("../../src/cli/main.js");
  const parsed = parseCliArgs(["--continue"]);
  expect(parsed.continue).toBe(true);
  expect(parsed.continueFile).toBeUndefined();
});

it("parses --continue <file>", async () => {
  const { parseCliArgs } = await import("../../src/cli/main.js");
  const parsed = parseCliArgs(["--continue", "session_123.jsonl"]);
  expect(parsed.continue).toBe(true);
  expect(parsed.continueFile).toBe("session_123.jsonl");
});

it("no --continue leaves continue flags unset", async () => {
  const { parseCliArgs } = await import("../../src/cli/main.js");
  const parsed = parseCliArgs(["-p", "hi"]);
  expect(parsed.continue).toBeUndefined();
  expect(parsed.continueFile).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/cli/main.test.ts`
预期：FAIL，`parsed.continue` 为 `undefined`（字段不存在）。

- [ ] **步骤 3：编写最少实现代码**

`src/cli/main.ts`：

1. 顶部补充 `import type { ChatMessage } from "../core/types.js";` 与 `import { SessionStore } from "../session/store.js";`。
2. `ParsedCliArgs` 增加字段：

```ts
export interface ParsedCliArgs {
  prompt?: string;
  workdir?: string;
  help?: boolean;
  skipPermissions?: boolean;
  continue?: boolean;
  continueFile?: string;
  cli: Record<string, string>;
}
```

3. 新增手动扫描函数（放在 `stringValue` 附近）：

```ts
function parseContinue(argv: string[]): { continue?: boolean; continueFile?: string } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--continue") continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      return { continue: true, continueFile: next };
    }
    return { continue: true };
  }
  return {};
}
```

4. `parseCliArgs` 返回值合并 `parseContinue(argv)`：

```ts
return {
  ...(help ? { help } : {}),
  ...(prompt !== undefined ? { prompt } : {}),
  ...(workdirValue !== undefined ? { workdir: workdirValue } : {}),
  ...(skipPermissions ? { skipPermissions } : {}),
  ...parseContinue(argv),
  cli,
};
```

5. `USAGE` 增加一行（在 `--dangerously-skip-permissions` 后）：

```
  --continue [FILE]     continue a previous session (latest, or FILE in .sessions/)
```

6. `main()` 解构并改写 REPL 分支：

```ts
const { prompt, workdir, cli, help, skipPermissions, continue: doContinue, continueFile } =
  parseCliArgs(process.argv.slice(2));
```

```ts
const harness = buildHarness(workdir, cli, makeAskUser(rl), skipPermissions);
log.info("start repl", { workdir: harness.config.workdir, model: harness.config.model });

let messages: ChatMessage[];
if (doContinue) {
  const file = continueFile
    ? path.join(harness.config.workdir, ".sessions", continueFile)
    : SessionStore.latest(harness.config.workdir);
  if (!file) {
    log.error("no session found to continue");
    process.exit(1);
  }
  harness.sessionStore = SessionStore.open(file);
  messages = harness.newSession();
  messages.push(...SessionStore.load(file));
} else {
  harness.sessionStore = SessionStore.create(harness.config.workdir);
  messages = harness.newSession();
}
await repl(harness, makeReadlineIO(rl), messages);
```

`src/cli/repl.ts`：

```ts
export async function repl(
  agent: TurnRunner,
  io: ReplIO,
  initialMessages?: ChatMessage[],
): Promise<void> {
  io.print("blh — type 'exit' to quit");
  const messages = initialMessages ?? agent.newSession();
  // ... 其余不变
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/cli/main.test.ts test/cli/repl.test.ts`
预期：PASS（`repl` 新参数为可选，既有 `repl(runner, io)` 调用仍兼容）。

- [ ] **步骤 5：类型检查**

运行：`pnpm exec tsc --noEmit`
预期：无错误。

- [ ] **步骤 6：Commit**

```bash
git add src/cli/main.ts src/cli/repl.ts test/cli/main.test.ts
git commit -m "feat: add --continue to resume a previous session"
```

---

## 任务 5：冒烟测试（真实落盘）

**文件：**
- 创建：`test/integration/session.test.ts`

- [ ] **步骤 1：编写冒烟测试**

创建 `test/integration/session.test.ts`：

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness } from "../../src/core/harness.js";
import { HookBus } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { ContextCompactor } from "../../src/compaction/compactor.js";
import { SessionStore } from "../../src/session/store.js";
import { MockProvider, makeTextMessage, makeToolCallMessage } from "./helpers.js";
import type { Config } from "../../src/core/types.js";

let tempDir: string;
let config: Config;

beforeEach(async () => {
  tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "blh-session-"));
  config = {
    apiKey: "k",
    model: "m",
    workdir: tempDir,
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
});

afterEach(async () => {
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

function makeHarness(script: ConstructorParameters<typeof MockProvider>[0], compactor?: ContextCompactor) {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (args) => `echoed:${String(args.text)}`,
  });
  return new Harness(config, new MockProvider(script), tools, new HookBus(), compactor);
}

describe("session 冒烟（真实落盘，仅 mock LLM）", () => {
  it("append 真实落盘：一轮对话产生唯一且无重复的 session 文件", async () => {
    const store = SessionStore.create(tempDir);
    const harness = makeHarness([
      makeToolCallMessage("echo", { text: "hi" }, "c1"),
      makeTextMessage("done"),
    ]);
    harness.sessionStore = store;
    const messages = harness.newSession();
    await harness.runTurn(messages, "echo hi");

    const files = fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const loaded = SessionStore.load(store.path);
    expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(loaded.some((m) => m.role === "system")).toBe(false);
  });

  it("压缩不产生 .transcripts 快照", async () => {
    const compactor = new ContextCompactor({
      provider: new MockProvider([]),
      toolResultsDir: path.join(tempDir, ".task_outputs", "tool-results"),
    });
    const store = SessionStore.create(tempDir);
    const harness = makeHarness([makeTextMessage("ok")], compactor);
    harness.sessionStore = store;
    const messages = harness.newSession();
    // 累积 51 条历史触发 snipCompact
    for (let i = 0; i < 26; i++) {
      await harness.runTurn(messages, `msg ${i}`);
    }
    const before = SessionStore.load(store.path).length;
    await harness.runTurn(messages, "trigger compaction");

    // 内存出现 marker
    expect(messages.some((m) => (m.content ?? "").includes("messages archived"))).toBe(true);
    // session 文件仍只有一个（无新快照）
    expect(fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    // append 只新增本轮 user + assistant
    expect(SessionStore.load(store.path).length - before).toBe(2);
    // 不产生 .transcripts
    expect(fs.existsSync(path.join(tempDir, ".transcripts"))).toBe(false);
  });

  it("--continue 恢复：latest + load 读回历史并续写同一文件", async () => {
    const store = SessionStore.create(tempDir);
    store.append({ role: "user", content: "hello" });
    store.append({ role: "assistant", content: "hi" });

    const latest = SessionStore.latest(tempDir);
    expect(latest).toBe(store.path);
    expect(SessionStore.load(latest!)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    const reopened = SessionStore.open(latest!);
    reopened.append({ role: "user", content: "again" });
    expect(SessionStore.load(latest!)).toHaveLength(3);
    expect(fs.readdirSync(path.join(tempDir, ".sessions")).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：运行冒烟测试**

运行：`pnpm exec vitest run test/integration/session.test.ts`
预期：PASS（3 条用例全绿）。

- [ ] **步骤 3：全量测试**

运行：`pnpm test`
预期：全部 PASS，无回归。

- [ ] **步骤 4：Commit**

```bash
git add test/integration/session.test.ts
git commit -m "test: add session persistence smoke tests"
```

---

## 自检

**规格覆盖度：**
- 单一 JSONL append → 任务 1（`SessionStore`）✅
- 移除 `writeTranscript` / `transcriptDir` → 任务 2 ✅
- marker 改 `[N messages archived]`、`summaryMessage` 去 `Full transcript` → 任务 2 ✅
- `Harness.sessionStore` + 三处 append → 任务 3 ✅
- `--continue` 恢复流程 → 任务 4 ✅
- `-p` 不持久化（`sessionStore` 未赋值即 `undefined`）→ 任务 3/4 ✅
- `.gitignore` 加 `.sessions/` → 任务 1 ✅
- 冒烟测试 → 任务 5 ✅

**规格中未覆盖到的边缘（有意收敛，遵循 YAGNI）：**
- 未做 `.transcripts/` 旧快照迁移/清理（规格「非目标」第 5 条）。
- 未扩展 `test/integration/live.test.ts`（规格 6.1 标注为「可选，依赖 API key，默认不跑」；本计划以 `MockProvider` 冒烟测试替代，覆盖同一链路）。

**类型一致性自检：**
- `SessionStore.create/open/latest/load/append` 签名在任务 1 定义，任务 3/4/5 一致使用。✅
- `summaryMessage(label, request, summary)` 新签名与 `compactHistory`/`reactiveCompact` 调用一致。✅
- `Harness.sessionStore?: SessionStore` 在任务 3 定义，任务 4/5 一致赋值。✅
- `repl(agent, io, initialMessages?)` 可选参数对既有测试向后兼容。✅
