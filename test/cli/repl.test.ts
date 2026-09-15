import { describe, it, expect, vi } from "vitest";
import { repl } from "../../src/cli/repl.js";
import type { TurnRunner } from "../../src/cli/repl.js";
import { makeTextMessage } from "../integration/helpers.js";
import type { ChatMessage } from "../../src/core/types.js";

function fakeRunner(replies: string[]): TurnRunner {
  let replyIndex = 0;
  return {
    newSession: () => [],
    runTurn: vi.fn(async (messages: ChatMessage[], _text: string) => {
      const reply = replies[replyIndex++] ?? "";
      messages.push(makeTextMessage(reply));
    }),
  };
}

async function runRepl(lines: string[], runner: TurnRunner) {
  const printed: string[] = [];
  const input = (async function* () {
    for (const line of lines) yield line;
  })();
  await repl(runner, {
    readLine: async () => {
      const next = await input.next();
      return next.done ? null : next.value; // null = EOF
    },
    print: (text: string) => {
      printed.push(text);
    },
  });
  return printed;
}

describe("repl", () => {
  it("prints banner and replies until exit", async () => {
    const runner = fakeRunner(["answer-1"]);
    const printed = await runRepl(["hello", "exit"], runner);
    expect(printed[0]).toBe("blh — type 'exit' to quit");
    expect(printed).toContain("answer-1");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
  });

  it("quits on EOF and on quit, skips empty lines", async () => {
    const runner = fakeRunner([]);
    const printed = await runRepl(["", "  ", "quit"], runner);
    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(printed).toHaveLength(1); // 只有 banner
  });

  it("stops on EOF (null)", async () => {
    const runner = fakeRunner(["r"]);
    const printed = await runRepl(["q1"], runner);
    expect(printed).toContain("r");
  });
});
