import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import type { JobsRuntime } from "../jobs/runtime.js";

/** repl 依赖的最小会话能力：结构化类型，测试可注入 fake */
export interface TurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string): Promise<void>;
  runScheduledTurn?(messages: ChatMessage[]): Promise<void>;
  jobs?: JobsRuntime | undefined;
}

export interface ReplIO {
  readLine: () => Promise<string | null>; // null = EOF
  print: (text: string) => void;
}

/** 从 start 起向队尾找最后一条 assistant 文本，只取本轮新增，避免打印 scheduled 旧回复 */
function lastAssistantTextFrom(messages: ChatMessage[], start: number): string {
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

export function makeReadlineIO(): ReplIO {
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    readLine: () =>
      new Promise((resolve) => {
        const onClose = () => resolve(null);
        readlineInterface.once("close", onClose);
        readlineInterface.question("> ", (answer) => {
          readlineInterface.removeListener("close", onClose);
          resolve(answer);
        });
      }),
    print: (text) => console.log(text),
  };
}

export async function repl(agent: TurnRunner, io: ReplIO): Promise<void> {
  io.print("blh — type 'exit' to quit");
  const messages = agent.newSession();
  const jobs = agent.jobs;
  const runScheduledTurn = agent.runScheduledTurn?.bind(agent);
  try {
    if (jobs !== undefined && runScheduledTurn !== undefined) {
      jobs.setCronTurn(async () => {
        const before = messages.length;
        await runScheduledTurn(messages);
        const reply = lastAssistantTextFrom(messages, before);
        if (reply) io.print(reply);
      });
      jobs.start();
    }
    for (;;) {
      const line = await io.readLine();
      if (line === null) {
        io.print("");
        break;
      }
      const text = line.trim();
      if (text === "exit" || text === "quit") break;
      if (!text) continue;
      if (jobs !== undefined) {
        await jobs.agentLock.withLock(async () => {
          const turnStart = messages.length;
          await agent.runTurn(messages, text);
          io.print(lastAssistantTextFrom(messages, turnStart));
        });
      } else {
        const turnStart = messages.length;
        await agent.runTurn(messages, text);
        io.print(lastAssistantTextFrom(messages, turnStart));
      }
    }
  } finally {
    if (jobs !== undefined) jobs.stop();
  }
}
