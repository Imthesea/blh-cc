# 流式输出 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在交互式终端 REPL 的正常用户轮次引入 LLM 文本与工具进度流式输出。

**架构：** 保留现有 `ChatMessage` 消息模型，新增两层事件（Provider 底层流事件 + agent 高层事件），中间用轻量 `EventBus` 串联；`OpenAIProvider` 新增可选 `stream()`，`agentLoop` 消费并转发，REPL 订阅渲染。`-p`、定时、team 轮次及所有内部 LLM 调用保持非流式。

**技术栈：** TypeScript、OpenAI SDK v4（流式 `chat.completions`）、Vitest。

---

## 关键实现约束（务必遵守）

1. **`exactOptionalPropertyTypes: true`**：本项目 tsconfig 开启了此项。含可选字段的事件对象不能直接把 `undefined` 赋给可选字段，必须用条件展开 `...(x ? { field: x } : {})`。本计划所有相关代码已按此编写，实现时不要"简化"成 `{ field: undefined }`。
2. **`noUncheckedIndexedAccess: true`**：数组下标访问返回 `T | undefined`，读 `chunk.choices[0]` 用可选链 `?.`。
3. **`ProviderStreamEvent.tool_call_delta` / `done` 的可选字段**：统一用条件展开，保证类型通过。
4. 高层事件 `tool_call` / `tool_result` 的字段（`id/name/arguments/output/isError`）都是必填，无此问题。
5. **流式优先、失败回退**：`agentLoop` 在「有 events 且 provider 有 `stream`」时默认走流式；`streamAssistantMessage` 抛错（含流中途异常）时回退到 `chat()` 非流式。回退后的 `chat()` 若再抛错（含 `prompt_too_long`），仍由外层 `catch` 走反应式压缩重试或上抛。

## 文件结构

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/core/events.ts` | 新增 | `AgentEvent` 类型 + `EventBus` 纯发布订阅总线 |
| `src/core/types.ts` | 修改 | 新增 `ChatUsage`、`ProviderStreamEvent`，`ChatProvider.stream?` |
| `src/providers/openai.ts` | 修改 | 扩展 `ChatCompletionsClient` 流式重载，实现 `stream()`，迁移 `ChatUsage` 至 types |
| `src/core/loop.ts` | 修改 | `agentLoop` 增加 `events?`，消费底层流，下发工具事件 |
| `src/core/harness.ts` | 修改 | `runTurn` 增加 `events?` 并透传 |
| `src/cli/repl.ts` | 修改 | `ReplIO.write`、`TurnRunner.runTurn` 签名、流式渲染器 |
| `test/core/events.test.ts` | 新增 | `EventBus` 单元测试 |
| `test/providers/openai.test.ts` | 修改 | `stream()` 单元测试 |
| `test/core/loop.test.ts` | 修改 | `agentLoop` 流式事件与降级测试 |
| `test/cli/repl.test.ts` | 修改 | 流式渲染与回退测试 |
| `test/cli/repl-io.test.ts` | 修改 | `write` 测试、补 `ReplIO.write` |

---

### 任务 1：EventBus 高层事件总线（新增）

**文件：**
- 创建：`src/core/events.ts`
- 测试：`test/core/events.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `test/core/events.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/core/events.js";
import type { AgentEvent } from "../../src/core/events.js";

describe("EventBus", () => {
  it("按注册顺序投递事件", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(async (e) => {
      seen.push(`a:${e.type}`);
    });
    bus.subscribe((e) => {
      seen.push(`b:${e.type}`);
    });
    await bus.emit({ type: "turn_start" });
    await bus.emit({ type: "assistant_text_delta", text: "hi" });
    expect(seen).toEqual([
      "a:turn_start",
      "b:turn_start",
      "a:assistant_text_delta",
      "b:assistant_text_delta",
    ]);
  });

  it("取消订阅后不再投递", async () => {
    const bus = new EventBus();
    const seen: AgentEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    await bus.emit({ type: "turn_start" });
    off();
    await bus.emit({ type: "turn_end" });
    expect(seen.map((e) => e.type)).toEqual(["turn_start"]);
  });

  it("监听器抛错被隔离，不影响其他监听器", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => seen.push(e.type));
    await expect(bus.emit({ type: "turn_end" })).resolves.toBeUndefined();
    expect(seen).toEqual(["turn_end"]);
  });

  it("串行等待异步监听器", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe(async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(e.type);
    });
    bus.subscribe((e) => order.push(`2:${e.type}`));
    await bus.emit({ type: "turn_start" });
    expect(order).toEqual(["turn_start", "2:turn_start"]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/core/events.test.ts`
预期：FAIL，报错 `Cannot find module '../../src/core/events.js'`

- [ ] **步骤 3：编写实现代码**

创建 `src/core/events.ts`：

```ts
import { createLogger } from "./logger.js";

const log = createLogger("core.events");

/** agentLoop 对外产出的高层事件：文本增量、工具进度与轮次边界。 */
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_end" };

type Listener = (event: AgentEvent) => void | Promise<void>;

/** 纯发布订阅事件总线：无返回值、无阻塞语义，供 REPL 订阅 agent 高层事件。 */
export class EventBus {
  private readonly listeners: Listener[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (error) {
        log.warn("event listener error", {
          type: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/core/events.test.ts`
预期：PASS（4 个用例全绿）

- [ ] **步骤 5：Commit**

```bash
git add src/core/events.ts test/core/events.test.ts
git commit -m "feat(core): add AgentEvent type and EventBus for streaming output"
```

---

### 任务 2：Provider 流式类型与 ChatUsage 迁移（type-only）

**文件：**
- 修改：`src/core/types.ts`
- 修改：`src/providers/openai.ts:1-12,137-140`

- [ ] **步骤 1：在 `types.ts` 增加类型并扩展 `ChatProvider`**

在 `src/core/types.ts` 末尾追加 `ChatUsage`、`ProviderStreamEvent`，并把 `ChatProvider` 改为：

```ts
/** 一次 LLM 调用的 token 用量 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Provider 底层流事件：text/tool_call 是增量，done 是拼好的完整消息 */
export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; message: ChatMessage; usage?: ChatUsage };

export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage>;
  stream?(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): AsyncIterable<ProviderStreamEvent>;
}
```

（即：把原 `ChatProvider` 的 `chat` 保留，新增可选 `stream?`；并在同一文件新增 `ChatUsage` 与 `ProviderStreamEvent`。）

- [ ] **步骤 2：从 `openai.ts` 移除本地 `ChatUsage`，改为从 types 导入**

修改 `src/providers/openai.ts`：

1. 顶部 import 增加 `ChatUsage`：

```ts
import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  Config,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
```

2. 删除文件末尾的本地定义（原 137-140 行）：

```ts
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}
```

- [ ] **步骤 3：运行类型检查验证通过**

运行：`pnpm typecheck`
预期：PASS（`workflow/runtime.ts` 通过 `chatCompletion` 的推断返回类型使用 `usage`，无需改动）

- [ ] **步骤 4：Commit**

```bash
git add src/core/types.ts src/providers/openai.ts
git commit -m "refactor(types): add ProviderStreamEvent/ChatUsage, move ChatUsage to core types"
```

---

### 任务 3：OpenAIProvider.stream() 实现（TDD）

**文件：**
- 修改：`src/providers/openai.ts:14-24`（`ChatCompletionsClient`）、新增 `stream()` 方法
- 测试：`test/providers/openai.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `test/providers/openai.test.ts` 末尾追加：

```ts
describe("OpenAIProvider.stream", () => {
  it("streams text deltas and yields assembled message with usage", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const chunks = [
      { choices: [{ index: 0, delta: { content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );
    const provider = new OpenAIProvider(config, makeClient(create));
    const events = [];
    for await (const event of provider.stream([{ role: "user", content: "hi" }], [])) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "done",
        message: { role: "assistant", content: "Hello" },
        usage: { promptTokens: 10, completionTokens: 2 },
      },
    ]);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, stream_options: { include_usage: true } }),
      { timeout: 600_000 },
    );
  });

  it("accumulates tool_call deltas by index into assembled tool_calls", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo" } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] } }] },
      { choices: [] },
    ];
    const create = vi.fn().mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );
    const provider = new OpenAIProvider(config, makeClient(create));
    const events = [];
    for await (const event of provider.stream([{ role: "user", content: "hi" }], [echoTool])) {
      events.push(event);
    }
    const done = events.find((e) => e.type === "done");
    expect(done).toEqual({
      type: "done",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "echo", arguments: '{"a":1}' } },
        ],
      },
    });
    expect(events.filter((e) => e.type === "tool_call_delta")).toHaveLength(3);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/providers/openai.test.ts`
预期：FAIL，报错 `provider.stream is not a function`

- [ ] **步骤 3：编写实现代码**

1. 扩展 `src/providers/openai.ts` 的 `ChatCompletionsClient`（原 14-24 行）为流式重载：

```ts
/** 最小化的 client 结构：provider 只依赖 chat.completions.create，便于测试注入 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
        options?: { timeout?: number },
      ): Promise<OpenAI.ChatCompletion>;
      create(
        params: OpenAI.ChatCompletionCreateParamsStreaming,
        options?: { timeout?: number },
      ): Promise<AsyncIterable<OpenAI.ChatCompletionChunk>>;
    };
  };
}
```

2. 在 `OpenAIProvider` 类内新增 `stream()`（放在 `chatCompletion` 之后）：

```ts
  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    maxTokens?: number,
  ): AsyncIterable<ProviderStreamEvent> {
    log.debug("stream request", { model: this.config.model, messages: messages.length, tools: tools.length });
    const stream = await withRetry(() =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: messages.map(toOpenAIMessage),
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length
            ? {
                tools: tools.map((tool) => ({
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        },
        { timeout: 600_000 },
      ),
    );

    let text = "";
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: ChatUsage | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const acc = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        calls.set(tc.index, acc);
        yield {
          type: "tool_call_delta",
          index: tc.index,
          ...(tc.id ? { id: tc.id } : {}),
          ...(tc.function?.name ? { name: tc.function.name } : {}),
          ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}),
        };
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
        };
      }
    }

    const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
    const message: ChatMessage = {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    yield { type: "done", message, ...(usage ? { usage } : {}) };
  }
```

3. 顶部 import 增加 `ProviderStreamEvent`：

```ts
import type {
  ChatMessage,
  ChatProvider,
  ChatUsage,
  Config,
  ProviderStreamEvent,
  ToolCall,
  ToolDefinition,
} from "../core/types.js";
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/providers/openai.test.ts`
预期：PASS（原有用例 + 2 个新流式用例全绿）

- [ ] **步骤 5：Commit**

```bash
git add src/providers/openai.ts test/providers/openai.test.ts
git commit -m "feat(providers): add streaming chat completions via OpenAIProvider.stream"
```

---

### 任务 4：agentLoop 流式接线（流式优先、失败回退）与工具事件下发（TDD）

**文件：**
- 修改：`src/core/harness.ts`
- 修改：`src/core/loop.ts`
- 测试：`test/core/loop.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `test/core/loop.test.ts` 顶部 import 区域：
- `import type { ... } from "../../src/core/types.js"` 追加 `ProviderStreamEvent`；
- 新增 `import { EventBus } from "../../src/core/events.js";` 和 `import type { AgentEvent } from "../../src/core/events.js";`

在文件末尾追加：

```ts
class StreamingProvider implements ChatProvider {
  constructor(private readonly script: ChatMessage[]) {}

  async chat(): Promise<ChatMessage> {
    throw new Error("StreamingProvider.chat unused");
  }

  async *stream(_messages: ChatMessage[], _tools: ToolDefinition[]): AsyncIterable<ProviderStreamEvent> {
    const message = this.script.shift();
    if (!message) throw new Error("StreamingProvider: script exhausted");
    if (message.content) yield { type: "text_delta", text: message.content };
    yield { type: "done", message };
  }
}

class FailingStreamProvider implements ChatProvider {
  constructor(private readonly script: ChatMessage[]) {}

  async chat(): Promise<ChatMessage> {
    const next = this.script.shift();
    if (!next) throw new Error("FailingStreamProvider: script exhausted");
    return next;
  }

  async *stream(): AsyncIterable<ProviderStreamEvent> {
    throw new Error("stream unsupported");
  }
}

describe("agentLoop streaming events", () => {
  it("emits turn/tool/text events in order via EventBus", async () => {
    const provider = new StreamingProvider([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "assistant_text_delta",
      "turn_end",
    ]);
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "echo",
      arguments: '{"text":"hi"}',
    });
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toEqual({
      type: "tool_result",
      id: "call_1",
      name: "echo",
      output: "echoed:hi",
      isError: false,
    });
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("falls back to non-streaming chat when provider has no stream", async () => {
    const provider = new MockProvider([
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    ]);
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect(lastAssistantText(messages)).toBe("done");
  });

  it("falls back to chat when streaming fails", async () => {
    const provider = new FailingStreamProvider(
      makeToolCallMessage("echo", { text: "hi" }),
      makeTextMessage("done"),
    );
    const harness = makeHarness([], { provider });
    const events: AgentEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      events.push(e);
    });
    const messages = harness.newSession();
    await harness.runTurn(messages, "go", bus);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "turn_end",
    ]);
    expect(lastAssistantText(messages)).toBe("done");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/core/loop.test.ts`
预期：FAIL，报错 `runTurn` 不接受第 3 个参数（或 `StreamingProvider` 无法作为 `ChatProvider` 传入，取决于类型检查时机；若类型层面先报错，先完成步骤 3 再运行）

- [ ] **步骤 3：编写实现代码**

**`src/core/harness.ts`**：

1. 顶部 import 增加 `EventBus` 类型：

```ts
import type { EventBus } from "./events.js";
```

2. `runTurn` 签名与 `agentLoop` 调用改为：

```ts
async runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void> {
  await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
  const userMessage: ChatMessage = { role: "user", content: text };
  messages.push(userMessage);
  this.sessionStore?.append(userMessage);
  const systemMessage = messages[0];
  if (this.memory && systemMessage) {
    systemMessage.content = await this.fullSystemPrompt(messages);
  }
  await agentLoop(this, messages, text, events);
  await this.hooks.trigger(STOP, {});
  if (this.memory && (await this.memory.extract(messages))) {
    await this.memory.consolidate();
  }
}
```

**`src/core/loop.ts`**：

1. 顶部 import 改为：

```ts
import type { ChatMessage, ChatProvider, ToolCall, ToolDefinition } from "./types.js";
import type { Harness } from "./harness.js";
import type { EventBus } from "./events.js";
import { PRE_TOOL_USE, POST_TOOL_USE } from "./hooks.js";
```

2. `agentLoop` 签名增加第 4 参数，并在 `for(;;)` 前发 `turn_start`：

```ts
export async function agentLoop(
  harness: Harness,
  messages: ChatMessage[],
  activeRequest = "",
  events?: EventBus,
): Promise<void> {
  const systemMessage: ChatMessage =
    messages[0] ?? { role: "system", content: harness.systemPrompt };
  let reactiveRetries = 0;
  await events?.emit({ type: "turn_start" });
  for (;;) {
```

3. 把取消息的 try 块改为「流式优先、失败回退非流式」：

```ts
    let message: ChatMessage;
    const streamAvailable = events !== undefined && harness.provider.stream !== undefined;
    try {
      if (streamAvailable) {
        try {
          message = await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events);
        } catch (error) {
          log.warn("stream failed, falling back to non-streaming", {
            error: error instanceof Error ? error.message : String(error),
          });
          message = await harness.provider.chat(messages, harness.tools.list());
        }
      } else {
        message = await harness.provider.chat(messages, harness.tools.list());
      }
      reactiveRetries = 0;
    } catch (error) {
```

4. 无工具调用的 `return` 前发 `turn_end`：

```ts
    if (toolCalls.length === 0) {
      const decision = await evaluateGoalStop(harness, messages);
      if (decision !== null && decision.action === "block") {
        const reminder: ChatMessage = { role: "user", content: goalReminder(harness.goal, decision) };
        messages.push(reminder);
        harness.sessionStore?.append(reminder);
        continue;
      }
      await events?.emit({ type: "turn_end" });
      return;
    }
```

5. 工具执行循环中，在 `const input = parseToolArguments(...)` 之后发 `tool_call`，在 `result` 计算完成后、push toolMessage 之前发 `tool_result`：

```ts
    for (const call of toolCalls) {
      const name = call.function.name;
      log.info("tool call", { tool: name });
      const input = parseToolArguments(call.function.arguments);
      await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
      let result: string;
      // ... 原有 compact / 后台 bash / 正常 dispatch 三个分支保持不变 ...
      await events?.emit({ type: "tool_result", id: call.id, name, output: result, isError: result.startsWith("error:") });
      const toolMessage: ChatMessage = { role: "tool", tool_call_id: call.id, content: result };
      messages.push(toolMessage);
      harness.sessionStore?.append(toolMessage);
    }
```

（说明：上述省略号处为原 97-125 行的分支逻辑，逐字保留，仅在 `let result: string;` 之前插入 tool_call 事件、在 push 前插入 tool_result 事件。）

6. 文件末尾新增 `streamAssistantMessage` 辅助函数：

```ts
/** 消费 Provider 底层流，转发文本增量，返回拼好的最终消息。 */
async function streamAssistantMessage(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  events: EventBus,
): Promise<ChatMessage> {
  const stream = provider.stream!(messages, tools);
  for await (const event of stream) {
    if (event.type === "text_delta") {
      await events.emit({ type: "assistant_text_delta", text: event.text });
    } else if (event.type === "done") {
      return event.message;
    }
  }
  throw new Error("provider stream ended without a done event");
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/core/loop.test.ts`
预期：PASS（原有用例 + 3 个新流式用例全绿）

- [ ] **步骤 5：Commit**

```bash
git add src/core/harness.ts src/core/loop.ts test/core/loop.test.ts
git commit -m "feat(core): stream assistant text and tool progress through agentLoop"
```

---

### 任务 5：ReplIO.write 扩展（TDD）

**文件：**
- 修改：`src/cli/repl.ts:21-24,36-70`
- 测试：`test/cli/repl-io.test.ts`
- 测试：`test/cli/repl.test.ts`（`runRepl` helper 补 `write`）

- [ ] **步骤 1：编写失败的测试**

`test/cli/repl-io.test.ts` 顶部 import 增加 `vi`：

```ts
import { describe, it, expect, vi } from "vitest";
```

并在文件末尾追加：

```ts
describe("makeReadlineIO.write", () => {
  it("原始输出不带换行", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const rl = readline.createInterface({ input: stdin, output: stdout });
      const io = makeReadlineIO(rl);
      io.write("hel");
      expect(write).toHaveBeenCalledWith("hel");
      rl.close();
    } finally {
      write.mockRestore();
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/cli/repl-io.test.ts`
预期：FAIL，`io.write is not a function`（或类型层面 `write` 不存在）

- [ ] **步骤 3：编写实现代码**

`src/cli/repl.ts`：

1. `ReplIO` 接口增加 `write`：

```ts
export interface ReplIO {
  readLine: () => Promise<string | null>; // null = EOF
  print: (text: string) => void;
  write: (text: string) => void;
}
```

2. `makeReadlineIO` 返回对象增加 `write`（`print` 之后）：

```ts
    write: (text) => {
      if (awaitingInput) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(text);
        readlineInterface.prompt(true);
      } else {
        process.stdout.write(text);
      }
    },
```

3. 同步修两个测试文件的 `ReplIO` 内联对象（否则 typecheck 失败）：
   - `test/cli/repl-io.test.ts` 的 `repl(harness, {...})` 对象补 `write: () => {}`。
   - `test/cli/repl.test.ts` 的 `runRepl` helper 的 `repl(runner, {...})` 对象补 `write: () => {}`。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/cli/repl-io.test.ts test/cli/repl.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/cli/repl.ts test/cli/repl-io.test.ts test/cli/repl.test.ts
git commit -m "feat(cli): add ReplIO.write for raw streaming text output"
```

---

### 任务 6：REPL 流式渲染接线（TDD）

**文件：**
- 修改：`src/cli/repl.ts`
- 测试：`test/cli/repl.test.ts`

- [ ] **步骤 1：编写失败的测试**

`test/cli/repl.test.ts` 顶部新增：

```ts
import { EventBus } from "../../src/core/events.js";
```

在 `describe("repl", ...)` 内追加：

```ts
  it("streams text deltas and tool progress without double-printing", async () => {
    const runner: TurnRunner = {
      newSession: () => [],
      runTurn: vi.fn(async (messages: ChatMessage[], _text: string, events?: EventBus) => {
        await events?.emit({ type: "turn_start" });
        await events?.emit({ type: "assistant_text_delta", text: "Hel" });
        await events?.emit({ type: "assistant_text_delta", text: "lo" });
        await events?.emit({ type: "tool_call", id: "c1", name: "echo", arguments: "{}" });
        await events?.emit({ type: "tool_result", id: "c1", name: "echo", output: "ok", isError: false });
        await events?.emit({ type: "turn_end" });
        messages.push(makeTextMessage("Hello"));
      }),
    };
    const printed: string[] = [];
    const writes: string[] = [];
    const input = (async function* () {
      yield "hello";
    })();
    await repl(runner, {
      readLine: async () => {
        const next = await input.next();
        return next.done ? null : next.value;
      },
      print: (text: string) => {
        printed.push(text);
      },
      write: (text: string) => {
        writes.push(text);
      },
    });
    expect(writes.join("")).toBe("Hello\n");
    expect(printed).toContain("[tool] echo {}");
    expect(printed).toContain("[ok] echo");
    expect(printed).not.toContain("Hello");
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run test/cli/repl.test.ts`
预期：FAIL，`writes` 为空（当前 `repl` 仍走 `io.print(lastAssistantTextFrom(...))`，输出到 `printed` 而非 `writes`）

- [ ] **步骤 3：编写实现代码**

`src/cli/repl.ts`：

1. 顶部 import 增加：

```ts
import { EventBus, type AgentEvent } from "../core/events.js";
```

2. `TurnRunner.runTurn` 签名增加 `events?`：

```ts
export interface TurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void>;
  runScheduledTurn?(messages: ChatMessage[]): Promise<void>;
  runTeamTurn?(messages: ChatMessage[]): Promise<void>;
  jobs?: JobsRuntime | undefined;
  agents?: TeamAgents | undefined;
  goal?: GoalController | undefined;
  goalCommand?: (text: string) => GoalCommand;
}
```

3. 在 `lastAssistantTextFrom` 之后新增渲染函数：

```ts
/** 把一条高层事件渲染到终端：文本增量原样写，工具/轮次边界换行。 */
function renderStreamEvent(io: ReplIO, event: AgentEvent, state: { textOpen: boolean }): void {
  switch (event.type) {
    case "turn_start":
      return;
    case "assistant_text_delta":
      state.textOpen = true;
      io.write(event.text);
      return;
    case "tool_call":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`[tool] ${event.name} ${event.arguments}`);
      return;
    case "tool_result":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`${event.isError ? "[error]" : "[ok]"} ${event.name}`);
      return;
    case "turn_end":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      return;
  }
}
```

4. 把 `repl()` 内正常用户轮次的 try 块（原 129-140 行）替换为：

```ts
      try {
        const run = async () => {
          const turnStart = messages.length;
          const events = new EventBus();
          const state = { textOpen: false };
          let streamed = false;
          const off = events.subscribe((event) => {
            if (event.type === "assistant_text_delta") streamed = true;
            renderStreamEvent(io, event, state);
          });
          try {
            await agent.runTurn(messages, text, events);
          } finally {
            off();
          }
          if (!streamed) io.print(lastAssistantTextFrom(messages, turnStart));
        };
        if (jobs !== undefined) {
          await jobs.agentLock.withLock(run);
        } else {
          await run();
        }
      } catch (error) {
        io.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run test/cli/repl.test.ts`
预期：PASS（原有用例 + 新流式用例全绿）

- [ ] **步骤 5：Commit**

```bash
git add src/cli/repl.ts test/cli/repl.test.ts
git commit -m "feat(cli): render streaming text and tool progress in REPL turns"
```

---

## 验收

全部任务完成后，依次运行并确认全部通过：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

预期：`typecheck` 无报错；`lint` 无报错；`test` 全量通过（新增 `events.test.ts`、`openai.test.ts` 流式、`loop.test.ts` 流式、`repl.test.ts` 流式渲染用例均绿）。

## 规格覆盖自检结论

- 事件模型（`ProviderStreamEvent` / `AgentEvent` / `EventBus`）：任务 1、2 覆盖。
- Provider 流式接口（`stream()` + client 重载 + `ChatUsage` 迁移）：任务 2、3 覆盖。
- agentLoop / Harness 接线：任务 4 覆盖。
- REPL 渲染（`write`、流式渲染器、回退打印）：任务 5、6 覆盖。
- 错误处理（监听器隔离、无 `stream` 走非流式、流式失败回退 `chat()`、回退后再失败仍走反应式压缩重试）：任务 1、4、6 覆盖；「流式中途已打印部分文本 + 回退重试」为 v1 已知接受项，无需代码。
- 测试清单：与设计文档第 9 节一一对应。
