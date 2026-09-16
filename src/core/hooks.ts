import { createLogger } from "./logger.js";

const log = createLogger("core.hooks");

export const USER_PROMPT_SUBMIT = "user_prompt_submit";
export const PRE_TOOL_USE = "pre_tool_use";
export const POST_TOOL_USE = "post_tool_use";
export const STOP = "stop";

/** 事件名 → payload 类型映射：register/trigger/firstBlock 据此保证事件与 payload 类型一致 */
export interface HookPayloads {
  [USER_PROMPT_SUBMIT]: { text: string };
  [PRE_TOOL_USE]: { name: string; input: Record<string, unknown> };
  [POST_TOOL_USE]: { name: string; input: Record<string, unknown>; output: string };
  [STOP]: Record<string, never>;
}

export type HookEvent = keyof HookPayloads;

export type HookFn<E extends HookEvent = HookEvent> = (
  payload: HookPayloads[E],
) => Promise<string | null>;

export class HookBus {
  private readonly hooks = new Map<HookEvent, HookFn[]>();

  register<E extends HookEvent>(event: E, fn: HookFn<E>): void {
    const list = this.hooks.get(event) ?? [];
    // HookFn<E> 的参数（联合中的某一成员）比存储类型 HookFn 的参数（全联合）窄，
    // 函数参数逆变使其无法直接赋值；事件名与 payload 的一致性已由泛型 E 绑定保证。
    list.push(fn as HookFn);
    this.hooks.set(event, list);
  }

  async trigger<E extends HookEvent>(
    event: E,
    payload: HookPayloads[E],
  ): Promise<Array<string | null>> {
    log.debug("trigger", { event });
    const results: Array<string | null> = [];
    for (const fn of this.hooks.get(event) ?? []) {
      results.push(await fn(payload));
    }
    return results;
  }

  async firstBlock<E extends HookEvent>(
    event: E,
    payload: HookPayloads[E],
  ): Promise<string | null> {
    log.debug("firstBlock", { event });
    for (const fn of this.hooks.get(event) ?? []) {
      const result = await fn(payload);
      if (result !== null) return result;
    }
    return null;
  }
}
