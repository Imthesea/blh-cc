import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import { lastAssistantText } from "../core/loop.js";

/** repl 依赖的最小会话能力：结构化类型，测试可注入 fake */
export interface TurnRunner {
  runTurn(text: string): Promise<ChatMessage[]>;
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
  for (;;) {
    const line = await io.readLine();
    if (line === null) {
      io.print("");
      break;
    }
    const text = line.trim();
    if (text === "exit" || text === "quit") break;
    if (!text) continue;
    const messages = await agent.runTurn(text);
    io.print(lastAssistantText(messages));
  }
}
