import readline from "node:readline";
import type { ChatMessage } from "../core/types.js";
import type { TeamAgents } from "../core/harness.js";
import type { JobsRuntime } from "../jobs/runtime.js";
import type { GoalController } from "../goals/controller.js";
import { EventBus, type AgentEvent } from "../core/events.js";

export type GoalCommand = "status" | "clear" | "set" | null;

/** repl 依赖的最小会话能力：结构化类型，测试可注入 fake */
export interface TurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void>;
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
  write: (text: string) => void;
}

/** 从 start 起向队尾找最后一条 assistant 文本，只取本轮新增，避免打印 scheduled 旧回复 */
function lastAssistantTextFrom(messages: ChatMessage[], start: number): string {
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content) return message.content;
  }
  return "";
}

/** 把一条高层事件渲染到终端：文本增量原样写，工具/轮次边界换行。 */
function renderStreamEvent(io: ReplIO, event: AgentEvent, state: { textOpen: boolean }): void {
  switch (event.type) {
    case "turn_start":
      return;
    case "assistant_text_delta":
      state.textOpen = true;
      io.write(event.text);
      return;
    case "tool_call":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`[tool] ${event.name} ${event.arguments}`);
      return;
    case "tool_result":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      io.print(`${event.isError ? "[error]" : "[ok]"} ${event.name}`);
      return;
    case "turn_end":
      if (state.textOpen) {
        io.write("\n");
        state.textOpen = false;
      }
      return;
  }
}

/** 造一个命令行输入输出对象：readLine 负责读一行，print 负责打印；打印时会处理"正在等输入"时的清屏重绘。 */
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
    write: (text) => {
      if (awaitingInput) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(text);
        readlineInterface.prompt(true);
      } else {
        process.stdout.write(text);
      }
    },
  };
}

/** 交互式主循环：读用户输入 → 跑一轮智能体 → 打印回复；同时接上定时任务和团队任务的后台处理。 */
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
        const run = async () => {
          const turnStart = messages.length;
          const events = new EventBus();
          const state = { textOpen: false };
          let streamed = false;
          const off = events.subscribe((event) => {
            if (event.type === "assistant_text_delta") streamed = true;
            renderStreamEvent(io, event, state);
          });
          try {
            await agent.runTurn(messages, text, events);
          } finally {
            off();
          }
          if (!streamed) io.print(lastAssistantTextFrom(messages, turnStart));
        };
        if (jobs !== undefined) {
          await jobs.agentLock.withLock(run);
        } else {
          await run();
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
