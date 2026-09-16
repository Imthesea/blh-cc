import type { ChatMessage } from "../core/types.js";
import type { BackgroundManager } from "./background.js";
import type { CronJob, CronScheduler } from "./cron.js";

/** 异步互斥锁：tryAcquire 同步抢锁；acquire 排队等待；release 把所有权移交下一个等待者 */
export class AgentLock {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  tryAcquire(): boolean {
    if (this.held) return false;
    this.held = true;
    return true;
  }

  acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.held = true;
        resolve();
      });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.held = false;
    } else {
      next(); // 所有权直接移交，held 保持 true
    }
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export class JobsRuntime {
  readonly agentLock = new AgentLock();
  private cronTurn: (() => Promise<void>) | null = null;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private queueTimer: NodeJS.Timeout | undefined;
  started = false;

  constructor(
    readonly background: BackgroundManager,
    readonly cron: CronScheduler,
  ) {}

  setCronTurn(callback: () => Promise<void>): void {
    this.cronTurn = callback;
  }

  injectBackgroundResults(messages: ChatMessage[]): number {
    const notifications = this.background.collect();
    for (const notification of notifications) {
      messages.push({ role: "user", content: notification });
    }
    return notifications.length;
  }

  consumeAndInjectCron(messages: ChatMessage[]): CronJob[] {
    const jobs = this.cron.consumeQueue();
    for (const job of jobs) {
      messages.push({ role: "user", content: `[Scheduled] ${job.prompt}` });
    }
    return jobs;
  }

  startBackground(command: string): string {
    const taskId = this.background.start(command);
    return (
      `[Background task ${taskId} started] ` +
      "The result will be collected on a later turn."
    );
  }

  start(): void {
    if (this.started) return;
    this.cron.load();
    this.schedulerTimer = setInterval(() => {
      try {
        this.cron.pollDue(new Date());
      } catch (error) {
        // Python 等价：线程未捕获异常 → 线程死亡；TS 停表 + 记录，避免崩进程
        if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer);
        console.log(`  [cron] scheduler stopped: ${error}`);
      }
    }, 1000);
    this.schedulerTimer.unref();
    this.queueTimer = setInterval(() => {
      this.processQueue().catch((error: unknown) => {
        // cronTurn 失败：停止队列处理（等价线程死亡，避免每 200ms 重试）
        if (this.queueTimer !== undefined) clearInterval(this.queueTimer);
        console.log(`  [cron] queue processor stopped: ${error}`);
      });
    }, 200);
    this.queueTimer.unref();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    if (this.schedulerTimer !== undefined) clearInterval(this.schedulerTimer);
    if (this.queueTimer !== undefined) clearInterval(this.queueTimer);
    this.schedulerTimer = undefined;
    this.queueTimer = undefined;
    this.started = false;
  }

  private async processQueue(): Promise<void> {
    if (!this.cron.hasQueue() || !this.agentLock.tryAcquire()) return;
    try {
      if (this.cron.hasQueue() && this.cronTurn !== null) {
        await this.cronTurn();
      }
    } finally {
      this.agentLock.release();
    }
  }
}
