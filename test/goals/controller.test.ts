import { describe, expect, it } from "vitest";
import { GoalController } from "../../src/goals/controller.js";
import type { GoalEvaluator } from "../../src/goals/evaluator.js";
import { GoalError, type GoalEvaluation } from "../../src/goals/types.js";

function evaluatorWith(result: GoalEvaluation): GoalEvaluator {
  return { evaluate: async () => result };
}

describe("GoalController", () => {
  it("no goal allow", async () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "", impossible: false }),
    );
    expect(await controller.evaluateAfterTurn([])).toEqual({ action: "allow", reason: "" });
  });

  it("ok achieved", async () => {
    const controller = new GoalController(
      evaluatorWith({ ok: true, reason: "done", impossible: false }),
    );
    controller.setGoal("finish");
    expect(await controller.evaluateAfterTurn([])).toEqual({
      action: "achieved",
      reason: "done",
    });
    expect(controller.active).toBeNull();
  });

  it("impossible failed", async () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "impossible", impossible: true }),
    );
    controller.setGoal("finish");
    expect(await controller.evaluateAfterTurn([])).toEqual({
      action: "failed",
      reason: "impossible",
    });
    expect(controller.active).toBeNull();
  });

  it("block then limit", async () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "not yet", impossible: false }),
      2,
    );
    controller.setGoal("finish");
    expect(await controller.evaluateAfterTurn([])).toEqual({
      action: "block",
      reason: "not yet",
    });
    expect(await controller.evaluateAfterTurn([])).toEqual({
      action: "block",
      reason: "not yet",
    });
    expect(await controller.evaluateAfterTurn([])).toEqual({
      action: "limit",
      reason: "goal remains active, but the Stop hook blocked 2 consecutive turns",
    });
  });

  it("clear", () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "", impossible: false }),
    );
    controller.setGoal("finish");
    expect(controller.clear()).toBe("Goal cleared: finish");
    expect(controller.active).toBeNull();
  });

  it("set goal empty raises", () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "", impossible: false }),
    );
    expect(() => controller.setGoal("   ")).toThrow(GoalError);
  });

  it("background defer", async () => {
    const controller = new GoalController(
      evaluatorWith({ ok: false, reason: "not yet", impossible: false }),
    );
    controller.setGoal("finish");
    expect(await controller.evaluateAfterTurn([], true)).toEqual({
      action: "defer",
      reason: "background work is still running",
    });
  });
});
