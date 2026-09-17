import { createLogger } from "./logger.js";

const log = createLogger("core.hooks");

/** 用户提交了提示词（每次用户输入、开始一轮之前触发）。 */
export const USER_PROMPT_SUBMIT = "user_prompt_submit";
/** 工具被调用之前触发。 */
export const PRE_TOOL_USE = "pre_tool_use";
/** 工具调用结束之后触发。 */
export const POST_TOOL_USE = "post_tool_use";
/** 一轮对话收尾时触发。 */
export const STOP = "stop";

/** 事件名 → 载荷类型 的映射：register/trigger/firstBlock 靠它保证事件名和载荷类型对得上。 */
export interface HookPayloads {
  [USER_PROMPT_SUBMIT]: { text: string };
  [PRE_TOOL_USE]: { name: string; input: Record<string, unknown> };
  [POST_TOOL_USE]: { name: string; input: Record<string, unknown>; output: string };
  [STOP]: Record<string, never>;
}

/** 事件的名称，就是 HookPayloads 里所有键。 */
export type HookEvent = keyof HookPayloads;

/** 一个钩子函数：接收对应事件的载荷，返回一个字符串或 null。 */
export type HookFn<E extends HookEvent = HookEvent> = (
  payload: HookPayloads[E],
) => Promise<string | null>;

/** 一个简单的事件总线：把「事件名 → 一串回调函数」存起来，触发时按顺序调用。 */
export class HookBus {
  /** 事件名 → 已注册的回调函数列表。 */
  private readonly hooks = new Map<HookEvent, HookFn[]>();

  /** 给某个事件注册一个回调函数：之后触发该事件时会依次调用它。 */
  register<E extends HookEvent>(event: E, fn: HookFn<E>): void {
    const list = this.hooks.get(event) ?? [];
    // HookFn<E> 接收「某一个具体事件」的载荷，而存储类型 HookFn 接收「所有事件」的载荷，
    // 前者参数更窄、后者参数更宽，TypeScript 不允许直接把窄的赋给宽的（参数逆变）；
    // 事件名和载荷本就被泛型 E 绑死，所以这里做一次类型断言是安全的。
    list.push(fn as HookFn);
    this.hooks.set(event, list);
  }

  /** 触发某个事件：按顺序调用它的所有回调，把每个回调的返回值收集成一个数组返回。 */
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

  /** 触发某个事件，但只要第一个「返回非 null」的回调结果就立刻返回；都没有则返回 null。 */
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
