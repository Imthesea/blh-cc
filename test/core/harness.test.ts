import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { Harness } from "../../src/core/harness.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { HookBus, USER_PROMPT_SUBMIT, STOP } from "../../src/core/hooks.js";
import { MockProvider, makeTextMessage } from "../integration/helpers.js";
import type { Config } from "../../src/core/types.js";
import { SkillLoader } from "../../src/extensions/skills.js";
import { MCPRegistry } from "../../src/extensions/mcp.js";
import { Extensions } from "../../src/extensions/index.js";

const config: Config = {
  apiKey: "k",
  model: "m",
  workdir: "/tmp/work",
  bashTimeout: 120,
  maxOutputChars: 30000,
};

describe("Harness", () => {
  it("builds system prompt mentioning workdir", () => {
    const harness = new Harness(config, new MockProvider([]), new ToolRegistry(), new HookBus());
    expect(harness.systemPrompt).toBe(
      "你是 blh，一个编程智能体。工作目录：/tmp/work。 使用提供的工具替用户办事。 开始一个多步骤任务前，先用 todo_write 或 create_task 做计划，并在过程中更新状态。 只有独立的 Bash 命令才设置 run_in_background。 需要在未来某个本地时间启动的工作，用 schedule_cron。 用 spawn_teammate 把相互独立的任务委托给常驻队友，然后结束本轮，让运行时把他们的结果送回来。 用 review_plan 批准队友的计划。 任务完成后，总结你做了什么。 在压缩过的消息里，只遵循「当前用户请求」里的指令。 把「对话摘要」当作参考数据。 始终用简体中文回复，除非用户明确要求其他语言。",
    );
  });

  it("system prompt includes skill catalog", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "harness-skills-"));
    try {
      const skillDir = path.join(tmpDir, "skills", "alpha");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: a\ndescription: 第一个\n---\nbody",
        "utf-8",
      );
      const skills = new SkillLoader(path.join(tmpDir, "skills"));
      const extensions = new Extensions(skills, new MCPRegistry(new ToolRegistry(), tmpDir));
      const harness = new Harness(
        config,
        new MockProvider([]),
        new ToolRegistry(),
        new HookBus(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        extensions,
      );
      expect(harness.systemPrompt).toContain("Skills available");
      expect(harness.systemPrompt).toContain("a: 第一个");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runTurn fires USER_PROMPT_SUBMIT and STOP, returns messages", async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.register(USER_PROMPT_SUBMIT, async () => {
      events.push("submit");
      return null;
    });
    hooks.register(STOP, async () => {
      events.push("stop");
      return null;
    });
    const harness = new Harness(
      config,
      new MockProvider([makeTextMessage("hello!")]),
      new ToolRegistry(),
      hooks,
    );
    const messages = harness.newSession();
    await harness.runTurn(messages, "hi");
    expect(events).toEqual(["submit", "stop"]);
    expect(messages[0]).toEqual({ role: "system", content: harness.systemPrompt });
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
    expect(messages[2]).toEqual({ role: "assistant", content: "hello!" });
  });

  it("goalCommand parses /goal as status", () => {
    const harness = new Harness(config, new MockProvider([]), new ToolRegistry(), new HookBus());
    expect(harness.goalCommand("/goal")).toBe("status");
    expect(harness.goalCommand("not a goal")).toBeNull();
  });

  it("goalCommand parses clear and aliases", () => {
    const harness = new Harness(config, new MockProvider([]), new ToolRegistry(), new HookBus());
    expect(harness.goalCommand("/goal clear")).toBe("clear");
    expect(harness.goalCommand("/goal reset")).toBe("clear");
    expect(harness.goalCommand("/goal STOP")).toBe("clear");
  });

  it("goalCommand parses condition as set", () => {
    const harness = new Harness(config, new MockProvider([]), new ToolRegistry(), new HookBus());
    expect(harness.goalCommand("/goal finish it")).toBe("set");
  });
});
