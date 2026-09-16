import { describe, expect, it } from "vitest";
import { PromptGoalEvaluator } from "../../src/goals/evaluator.js";
import { GoalError } from "../../src/goals/types.js";
import { MockProvider } from "../integration/helpers.js";

describe("goal evaluator", () => {
  it("evaluate ok", async () => {
    const evaluator = new PromptGoalEvaluator(
      new MockProvider([
        { role: "assistant", content: '{"ok": true, "reason": "done", "impossible": false}' },
      ]),
    );
    const result = await evaluator.evaluate("finish", []);
    expect(result).toEqual({ ok: true, reason: "done", impossible: false });
  });

  it("evaluate invalid json raises", async () => {
    const evaluator = new PromptGoalEvaluator(
      new MockProvider([{ role: "assistant", content: "not json" }]),
    );
    await expect(evaluator.evaluate("finish", [])).rejects.toThrow(GoalError);
  });
});
