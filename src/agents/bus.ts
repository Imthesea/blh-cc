import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import * as path from "node:path";

const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAgentName(name: string): boolean {
  return VALID_AGENT_NAME.test(name);
}

export interface BusMessage {
  from: string;
  to: string;
  content: string;
  type: string;
  ts: number;
  metadata: Record<string, unknown>;
}

/** 文件收件箱：单线程下天然线程安全，破坏性读（read 后删除）。 */
export class MessageBus {
  constructor(readonly mailboxDir: string) {}

  private pathFor(agent: string): string {
    if (!isValidAgentName(agent)) {
      throw new Error(`Invalid mailbox recipient: ${JSON.stringify(agent)}`);
    }
    const resolved = path.resolve(this.mailboxDir, `${agent}.jsonl`);
    const root = path.resolve(this.mailboxDir);
    if (path.dirname(resolved) !== root) {
      throw new Error(`Mailbox path escapes directory: ${JSON.stringify(agent)}`);
    }
    return resolved;
  }

  send(
    fromAgent: string,
    toAgent: string,
    content: string,
    type = "message",
    metadata: Record<string, unknown> = {},
  ): void {
    const message: BusMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type,
      ts: Date.now() / 1000,
      metadata,
    };
    mkdirSync(this.mailboxDir, { recursive: true });
    appendFileSync(this.pathFor(toAgent), JSON.stringify(message) + "\n", "utf8");
  }

  readInbox(agent: string): BusMessage[] {
    const inbox = this.pathFor(agent);
    if (!existsSync(inbox)) return [];
    const messages = readFileSync(inbox, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as BusMessage);
    unlinkSync(inbox);
    return messages;
  }

  peek(agent: string): boolean {
    const inbox = this.pathFor(agent);
    return existsSync(inbox) && statSync(inbox).size > 0;
  }

  /** Python 的阻塞等待 → TS 的轮询等待：无消息时每 20ms 检查一次直到超时。 */
  async waitForMessages(agent: string, timeoutMs?: number): Promise<BusMessage[]> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      if (this.peek(agent)) return this.readInbox(agent);
      if (deadline !== undefined && Date.now() >= deadline) return [];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
