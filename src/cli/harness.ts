import * as path from "node:path";
import { loadConfig } from "../core/config.js";
import { ContextCompactor } from "../compaction/compactor.js";
import { registerCompactTool } from "../compaction/compactTool.js";
import { Harness } from "../core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../core/hooks.js";
import { OpenAIProvider } from "../providers/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/index.js";
import {
  DEFAULT_RULES,
  SKIP_PERMISSIONS_RULES,
  insertUserRule,
  type PermissionRule,
} from "../security/rules.js";
import { makePermissionHook, type ApprovalAsker } from "../security/approval.js";
import { TaskStore } from "../planning/tasks.js";
import { TodoManager } from "../planning/todo.js";
import { registerPlanningTools } from "../planning/tools.js";
import { MemoryStore } from "../memory/store.js";
import { Memory } from "../memory/system.js";
import { BackgroundManager } from "../jobs/background.js";
import { CronScheduler } from "../jobs/cron.js";
import { JobsRuntime } from "../jobs/runtime.js";
import { registerJobsTools } from "../jobs/tools.js";
import { MessageBus } from "../agents/bus.js";
import { SubagentRunner } from "../agents/subagent.js";
import { TeamRuntime } from "../agents/team.js";
import { registerAgentTools } from "../agents/tools.js";
import { SkillLoader } from "../extensions/skills.js";
import { MCPRegistry } from "../extensions/mcp.js";
import { registerExtensionTools } from "../extensions/tools.js";
import { Extensions } from "../extensions/index.js";
import { PromptGoalEvaluator } from "../goals/evaluator.js";
import { GoalController } from "../goals/controller.js";
import { OpenAIWorkflowRunner } from "../workflow/runtime.js";
import { WORKFLOWS } from "../workflow/registry.js";
import { registerWorkflowTools } from "../workflow/tools.js";
import { initLogger } from "@blh/logger";

export function buildHarness(
  workdir?: string,
  cli?: Record<string, unknown>,
  askUser?: ApprovalAsker,
  skipPermissions = false,
  opts?: {
    userRules?: PermissionRule[];
    persistRule?: (rule: PermissionRule) => void;
  },
): Harness {
  const config = loadConfig(workdir, cli);
  initLogger(config.workdir);
  const provider = new OpenAIProvider(config);
  const tools = new ToolRegistry();
  const hooks = new HookBus();
  registerBuiltinTools(tools, config);
  const base = skipPermissions ? SKIP_PERMISSIONS_RULES : DEFAULT_RULES;
  const rules = [...base];
  for (const r of opts?.userRules ?? []) insertUserRule(rules, r);
  const permissionHook = makePermissionHook(rules, askUser, opts?.persistRule);
  hooks.register(PRE_TOOL_USE, (payload) => permissionHook(payload.name, payload.input));
  registerCompactTool(tools);
  const todoManager = new TodoManager();
  const taskStore = new TaskStore(path.join(config.workdir, ".tasks"));
  registerPlanningTools(tools, todoManager, taskStore);
  const memory = new Memory(new MemoryStore(path.join(config.workdir, ".memory")), provider);
  const cron = new CronScheduler(path.join(config.workdir, ".scheduled_tasks.json"));
  cron.load();
  registerJobsTools(tools, cron);
  const jobs = new JobsRuntime(
    new BackgroundManager(config.workdir, config.bashTimeout, config.maxOutputChars),
    cron,
  );
  const compactor = new ContextCompactor({
    provider,
    toolResultsDir: path.join(config.workdir, ".task_outputs", "tool-results"),
  });
  const agents = new TeamRuntime(
    taskStore,
    new MessageBus(path.join(config.workdir, ".mailboxes")),
    jobs.agentLock,
    config.workdir,
    path.join(config.workdir, ".worktrees"),
    provider,
    config,
    hooks,
  );
  const subagent = new SubagentRunner(provider, config, hooks);
  registerAgentTools(tools, subagent, agents);
  const skills = new SkillLoader(path.join(config.workdir, "skills"));
  const mcp = new MCPRegistry(tools, config.workdir);
  registerExtensionTools(tools, skills, mcp);
  const extensions = new Extensions(skills, mcp);
  const workflowStore = path.join(config.workdir, ".workflow_runtime");
  registerWorkflowTools(tools, workflowStore, () => new OpenAIWorkflowRunner(provider), WORKFLOWS);
  const goal = new GoalController(new PromptGoalEvaluator(provider));
  return new Harness(config, provider, tools, hooks, compactor, todoManager, memory, jobs, agents, extensions, goal, workflowStore);
}
