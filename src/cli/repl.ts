import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import type { TeamAgents } from "../core/harness.js";
import type { JobsRuntime } from "../jobs/runtime.js";
import type { GoalController } from "../goals/controller.js";

export type GoalCommand = "status" | "clear" | "set" | null;

/** repl 依赖的最小会话能力：结构化类型，测试可注入 fake */
export interface TurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string): Promise<void>;
  runScheduledTurn?(messages: ChatMessage[]): Promise<void>;
  runTeamTurn?(messages: ChatMessage[]): Promise<void>;
  jobs?: JobsRuntime | undefined;
  agents?: TeamAgents | undefined;
  goal?: GoalController | undefined;
  goalCommand?: (text: string) => GoalCommand;
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

export function makeReadlineIO(rl?: readline.Interface): ReplIO {
  const readlineInterface =
    rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  let awaitingInput = false;
  return {
    readLine: () =>
      new Promise((resolve) => {
        const onClose = () => {
          awaitingInput = false;
          resolve(null);
        };
        readlineInterface.once("close", onClose);
        awaitingInput = true;
        readlineInterface.question("> ", (answer) => {
          awaitingInput = false;
          readlineInterface.removeListener("close", onClose);
          resolve(answer);
        });
      }),
    print: (text) => {
      if (awaitingInput) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(`${text}\n`);
        readlineInterface.prompt(true);
      } else {
        console.log(text);
      }
    },
  };
}

export async function repl(
  agent: TurnRunner,
  io: ReplIO,
  initialMessages?: ChatMessage[],
): Promise<void> {
  io.print("blh — type 'exit' to quit");
  const messages = initialMessages ?? agent.newSession();
  const jobs = agent.jobs;
  const runScheduledTurn = agent.runScheduledTurn?.bind(agent);
  const agents = agent.agents;
  const runTeamTurn = agent.runTeamTurn?.bind(agent);
  const goal = agent.goal;
  const goalCommand = agent.goalCommand?.bind(agent);
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
    if (agents !== undefined && runTeamTurn !== undefined) {
      agents.setTeamTurn?.(async () => {
        const before = messages.length;
        await runTeamTurn(messages);
        const reply = lastAssistantTextFrom(messages, before);
        if (reply) io.print(reply);
      });
      agents.start?.();
    }
    for (;;) {
      const line = await io.readLine();
      if (line === null) {
        io.print("");
        break;
      }
      let text = line.trim();
      if (text === "exit" || text === "quit") break;
      if (!text) continue;
      if (goal !== undefined && goalCommand !== undefined) {
        const cmd = goalCommand(text);
        if (cmd === "status") {
          io.print(goal.status(0));
          continue;
        }
        if (cmd === "clear") {
          io.print(goal.clear());
          continue;
        }
        if (cmd === "set") {
          goal.setGoal(text.slice(6).trim());
          text = text.slice(6).trim();
        }
      }
      try {
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
      } catch (error) {
        io.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    agents?.stop?.();
    if (jobs !== undefined) jobs.stop();
  }
}
