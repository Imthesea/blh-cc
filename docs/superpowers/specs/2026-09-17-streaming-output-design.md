# 流式输出设计（Streaming Output）

- 日期：2026-09-17
- 状态：待审查

## 1. 背景与目标

blh-claude-code-ts 当前没有流式输出：`OpenAIProvider.chat()` 使用非流式 `chat.completions.create`，`agentLoop` 拿到完整 `ChatMessage` 后才执行工具；`repl` 在整轮结束后才用 `lastAssistantTextFrom` 打印最终回复。用户在整个 agent 轮次期间看不到任何中间输出，长回复或慢工具调用时体验很差。

参考 re-pi 项目的事件流架构，目标是在**交互式终端 REPL 的正常用户轮次**引入流式输出：

- LLM 文本逐字打印，不再等到整轮结束。
- 工具调用开始与结果实时显示。
- 采用统一事件流架构，为后续 web/SSE 输出打基础。

## 2. 核心决策

| 决策点 | 选择 |
|--------|------|
| 落地入口 | 仅终端 REPL（`-p` 模式、定时/team 轮次保持非流式） |
| 重构深度 | 保留现有 `ChatMessage` 消息模型，新增事件层 |
| 事件架构 | 两层事件：Provider 底层流事件 + agent 高层事件，中间用轻量 `EventBus` 串联 |
| Provider 接口 | 新增可选 `stream()`；`chat()`/`chatCompletion()` 保持不变 |
| 内部 LLM 调用 | compactor / memory / goal / workflow / subagent / teammate 继续走非流式 `chat()` |

## 3. 架构

```
OpenAIProvider.stream()  →  底层流事件 ProviderStreamEvent
        ↓ agentLoop 消费并累积成 ChatMessage
     EventBus 对外发高层事件 AgentEvent
        ↓ REPL 订阅
    终端渲染（文本增量 + 工具进度）
```

高层事件只在交互式 REPL 的正常用户轮次下发；`-p`、定时、team 轮次以及所有内部 LLM 调用都不发事件、走非流式。

## 4. 事件模型

### 4.1 底层流事件（Provider 产出）

定义在 `src/core/types.ts`：

```ts
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "done"; message: ChatMessage; usage?: ChatUsage };
```

- `text_delta` / `tool_call_delta`：OpenAI 流式 chunk 的原始增量；`tool_call_delta` 的 `index` 用于区分同一消息中的多个工具调用。
- `done`：Provider 内部把增量拼成完整 `ChatMessage` 后发出；`agentLoop` 直接用 `done.message`，不再自己拼装。

### 4.2 高层事件（agentLoop 产出）

定义在新文件 `src/core/events.ts`：

```ts
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_end" };
```

事件顺序：一次用户轮次内，`turn_start` → 若干 `assistant_text_delta`（流式）→ 若干 `tool_call` / `tool_result`（文本之后，因为工具在整条 assistant 消息完成后才执行）→ `turn_end`。若模型连续多轮调用工具，则重复「文本增量 → 工具」这一组。

### 4.3 EventBus

定义在 `src/core/events.ts`。与现有 `HookBus` 不同，它是纯发布订阅，无返回值、无阻塞语义：

```ts
export class EventBus {
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  emit(event: AgentEvent): Promise<void>; // 顺序投递；单个监听器抛错被隔离，不影响其他监听器
}
```

- `subscribe` 返回取消订阅函数。
- `emit` 按注册顺序串行等待监听器完成；某监听器异常仅记录日志，不中断后续监听器。

## 5. Provider 流式接口

### 5.1 接口变更

`src/core/types.ts` 的 `ChatProvider` 新增**可选** `stream`（可选是为了不破坏现有测试 fake；`agentLoop` 拿不到 `stream` 时退化为非流式）：

```ts
export interface ChatProvider {
  chat(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): Promise<ChatMessage>;
  stream?(messages: ChatMessage[], tools: ToolDefinition[], maxTokens?: number): AsyncIterable<ProviderStreamEvent>;
}
```

### 5.2 OpenAIProvider 实现

`src/providers/openai.ts`：

1. 扩展现有 `ChatCompletionsClient`，让 `create` 同时支持流式与非流式（OpenAI SDK 本身是重载；流式返回 `AsyncIterable<ChatCompletionChunk>`）。
2. 新增 `async *stream()`：
   - 用 `stream: true` + `stream_options: { include_usage: true }` 发起请求。
   - `withRetry` 只包住「发起请求」；流开始后的 chunk 不再重试，中途异常直接向上抛，交给 `agentLoop` 处理。
   - 遍历 chunk：`delta.content` 累积文本并 `yield text_delta`；`delta.tool_calls` 按 `index` 累积 `id/name/arguments` 并 `yield tool_call_delta`。
   - 流结束后把累积结果拼成完整 `ChatMessage`（`content` 为 null 时保持 null，`tool_calls` 存在才带上），`yield done` 并附 `usage`。
   - `stream_options.include_usage` 是 OpenAI 专属字段，部分兼容端可能拒绝；若目标后端不支持，`usage` 留空即可（`done.usage` 已可选）。

```ts
async *stream(messages, tools, maxTokens?): AsyncIterable<ProviderStreamEvent> {
  const stream = await withRetry(() =>
    this.client.chat.completions.create({
      model: this.config.model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length ? { tools: /* 同 chat */ } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    }, { timeout: 600_000 }),
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
      yield { type: "tool_call_delta", index: tc.index, id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
    }
    if (chunk.usage) {
      usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
    }
  }

  const toolCalls = [...calls.values()].map((c) => ({
    id: c.id, type: "function" as const,
    function: { name: c.name, arguments: c.arguments },
  }));
  const message: ChatMessage = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  yield { type: "done", message, usage };
}
```

3. `ChatUsage` 从 `openai.ts` 移到 `types.ts`（`ProviderStreamEvent.done.usage` 需要引用，避免循环依赖）。`workflow/runtime.ts` 只使用 `chatCompletion` 的推断返回类型，无需改动。

## 6. agentLoop 与 Harness 接线

### 6.1 agentLoop

`src/core/loop.ts` 的 `agentLoop` 增加可选第 4 参数 `events?: EventBus`。

- 顶部（进入 `for(;;)` 前）`await events?.emit({ type: "turn_start" })`。
- 每次取 assistant 消息时，若 `events` 存在且 `provider.stream` 存在则走流式，否则走原 `chat()`：

```ts
const canStream = events !== undefined && harness.provider.stream !== undefined;
try {
  message = canStream
    ? await streamAssistantMessage(harness.provider, messages, harness.tools.list(), events)
    : await harness.provider.chat(messages, harness.tools.list());
  reactiveRetries = 0;
} catch (error) {
  // 保留现有 isPromptTooLong 反应式压缩逻辑
  ...
}
```

其中 `streamAssistantMessage` 消费底层流并转发文本增量，返回最终消息：

```ts
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

- 工具执行循环（现有 lines 82–122）在每次 dispatch 前后发事件：

```ts
await events?.emit({ type: "tool_call", id: call.id, name, arguments: call.function.arguments });
// ... 执行得到 result ...
await events?.emit({ type: "tool_result", id: call.id, name, output: result, isError: result.startsWith("error:") });
```

- 无工具调用的 `return` 前 `await events?.emit({ type: "turn_end" })`。

### 6.2 Harness

`src/core/harness.ts` 的 `runTurn` 增加可选 `events?: EventBus` 并透传给 `agentLoop`。`runScheduledTurn` / `runTeamTurn` 不传，保持非流式。

```ts
async runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void> {
  ...
  await agentLoop(this, messages, text, events);
  ...
}
```

## 7. REPL 渲染

### 7.1 ReplIO 扩展

`src/cli/repl.ts` 的 `ReplIO` 增加 `write(text: string): void`（原始输出、无换行、readline 感知），供文本增量使用；`makeReadlineIO` 实现它（`awaitingInput` 时清行重绘，否则直接 `process.stdout.write`）。

### 7.2 正常用户轮次

`repl()` 中，正常用户轮次创建独立 `EventBus`、订阅渲染器，并把 `events` 传给 `runTurn`：

```ts
const turnStart = messages.length;
const events = new EventBus();
const state = { textOpen: false };
let streamed = false;
const off = events.subscribe((event) => {
  streamed = true;
  renderStreamEvent(io, event, state);
});
try {
  await agent.runTurn(messages, text, events);
} finally {
  off();
}
if (!streamed) io.print(lastAssistantTextFrom(messages, turnStart));
```

- 文本增量用 `io.write` 逐个打印，不换行。
- `tool_call` 前先结束当前文本行；`tool_result` 显示成功/失败标记；`turn_end` 结束文本行。
- `streamed` 为 false（Provider 无 `stream`，例如测试 fake）时，回退到原来的 `lastAssistantTextFrom` 打印，避免重复打印。

渲染标记使用纯文本（避免 emoji）：工具调用 `[tool] <name> <arguments>`，结果 `[ok]` / `[error] <name>`。

### 7.3 其他轮次

定时轮次（`runScheduledTurn`）与 team 轮次（`runTeamTurn`）保持现状：非流式，结束后用 `lastAssistantTextFrom` 打印最终回复。

## 8. 错误处理

1. **流中途异常**：`stream()` 迭代抛错 → `streamAssistantMessage` 抛错 → 被 `agentLoop` 的 `try/catch` 捕获。若 `isPromptTooLong` 触发反应式压缩重试；否则向上抛，`repl` 的 catch 打印错误。
2. **已打印文本的取舍**：若流中途因上下文超长触发压缩重试，已流式打印的部分文本会留在终端；重试后的回复重新打印，可能出现重复片段。这是流式 + 重试的已知取舍，v1 接受。
3. **Provider 无 `stream`**：`canStream` 为 false，走非流式 `chat()`；REPL 因 `streamed === false` 回退打印最终文本，行为与现状一致。
4. **监听器异常隔离**：`EventBus.emit` 内单个监听器抛错只记日志，不影响后续监听器与主流程。

## 9. 测试

1. `test/core/events.test.ts`（新增）：`EventBus` 的 `subscribe`/`emit`/取消订阅、顺序投递、监听器异常隔离。
2. `test/providers/openai.test.ts`（扩展）：mock `create` 返回异步可迭代 chunk，断言 `stream()` 产出正确的 `text_delta`/`tool_call_delta`/`done`（含拼装后的 `ChatMessage` 与 `usage`）。
3. `test/core/loop.test.ts`（扩展）：给定流式 provider + `EventBus`，断言 agentLoop 按序发出 `turn_start` → `assistant_text_delta` → `tool_call` → `tool_result` → `turn_end`；并验证非流式路径（无 events 或 provider 无 stream）行为不变。
4. `test/cli/repl.test.ts` / `repl-io.test.ts`（扩展）：验证文本增量与工具进度渲染、无 `stream` 时回退打印最终文本、不重复打印。

## 10. 变更文件清单

- 新增 `src/core/events.ts`：`AgentEvent` + `EventBus`。
- 修改 `src/core/types.ts`：新增 `ChatUsage`、`ProviderStreamEvent`，`ChatProvider.stream?`。
- 修改 `src/providers/openai.ts`：实现 `stream()`、扩展 client 类型、移除本地 `ChatUsage`（迁至 types.ts）。
- 修改 `src/core/loop.ts`：`agentLoop` 增加 `events?`、流式消费、工具事件下发。
- 修改 `src/core/harness.ts`：`runTurn` 增加 `events?`。
- 修改 `src/cli/repl.ts`：`ReplIO.write`、`TurnRunner.runTurn` 签名、流式渲染器。
- 新增/扩展上述测试文件。
