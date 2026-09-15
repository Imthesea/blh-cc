import { describe, it, expect, vi } from "vitest";
import type { Config, ToolDefinition } from "../../src/core/types.js";

const config: Config = {
  apiKey: "sk-test",
  baseUrl: "http://fake/v1",
  model: "test-model",
  workdir: "/tmp",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

function makeClient(create: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create } } };
}

const echoTool: ToolDefinition = {
  name: "echo",
  description: "echo tool",
  parameters: { type: "object" },
  handler: async () => "",
};

describe("OpenAIProvider", () => {
  it("calls chat.completions.create with model/messages/tools and returns first message", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const message = { role: "assistant", content: "hi" };
    const create = vi.fn().mockResolvedValue({ choices: [{ message }] });
    const provider = new OpenAIProvider(config, makeClient(create));
    const result = await provider.chat([{ role: "user", content: "hello" }], [echoTool]);
    expect(create).toHaveBeenCalledWith(
      {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "echo", description: "echo tool", parameters: { type: "object" } },
          },
        ],
      },
      { timeout: 600_000 },
    );
    expect(result).toEqual({ role: "assistant", content: "hi" });
  });

  it("passes tools as undefined when empty", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const provider = new OpenAIProvider(config, makeClient(create));
    await provider.chat([{ role: "user", content: "hi" }], []);
    expect(create.mock.calls[0]?.[0].tools).toBeUndefined();
  });

  it("retries 429 via withRetry", async () => {
    vi.useFakeTimers();
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    const provider = new OpenAIProvider(config, makeClient(create));
    const chatPromise = provider.chat([{ role: "user", content: "hi" }], []);
    await vi.runAllTimersAsync();
    await expect(chatPromise).resolves.toEqual({ role: "assistant", content: "ok" });
    expect(create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
