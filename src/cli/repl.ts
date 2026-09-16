import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import { lastAssistantText } from "../core/loop.js";
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

export function makeReadlineIO(): ReplIO {
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    readLine: () =>
      new Promise((resolve) => {
        readlineInterface.question("> ", (answer) => resolve(answer));
        readlineInterface.once("close", () => resolve(null));
      }),
    print: (text) => console.log(text),
  };
}

export async function repl(agent: TurnRunner, io: ReplIO): Promise<void> {
  io.print("blh — type 'exit' to quit");
  const messages = agent.newSession();
  const jobs = agent.jobs;
  const runScheduledTurn = agent.runScheduledTurn?.bind(agent);
  if (jobs !== undefined && runScheduledTurn !== undefined) {
    jobs.setCronTurn(() => runScheduledTurn(messages));
    jobs.start();
  }
  try {
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
        await jobs.agentLock.withLock(() => agent.runTurn(messages, text));
      } else {
        await agent.runTurn(messages, text);
      }
      io.print(lastAssistantText(messages));
    }
  } finally {
    if (jobs !== undefined) jobs.stop();
  }
}
