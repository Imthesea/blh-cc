import type { ChatMessage, ChatProvider, Config } from "./types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { HookBus } from "./hooks.js";
import { USER_PROMPT_SUBMIT, STOP } from "./hooks.js";
import { agentLoop } from "./loop.js";

export class Harness {
  readonly systemPrompt: string;

  constructor(
    readonly config: Config,
    readonly provider: ChatProvider,
    readonly tools: ToolRegistry,
    readonly hooks: HookBus,
  ) {
    this.systemPrompt =
      `You are blh, a coding agent. Workdir: ${config.workdir}. ` +
      "Use the provided tools to act on the user's behalf. " +
      "When the task is complete, summarize what you did.";
  }

  async runTurn(text: string): Promise<ChatMessage[]> {
    await this.hooks.trigger(USER_PROMPT_SUBMIT, { text });
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: text },
    ];
    await agentLoop(this, messages);
    await this.hooks.trigger(STOP, {});
    return messages;
  }
}
