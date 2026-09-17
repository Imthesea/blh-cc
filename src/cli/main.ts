#!/usr/bin/env node
import readline from "node:readline";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../core/config.js";
import { ContextCompactor } from "../compaction/compactor.js";
import { registerCompactTool } from "../compaction/compactTool.js";
import { Harness } from "../core/harness.js";
import { HookBus, PRE_TOOL_USE } from "../core/hooks.js";
import { lastAssistantText } from "../core/loop.js";
import { OpenAIProvider } from "../providers/openai.js";
import { ToolRegistry } from "../tools/registry.js";
import { registerBuiltinTools } from "../tools/index.js";
import { DEFAULT_RULES, SKIP_PERMISSIONS_RULES } from "../security/rules.js";
import { makePermissionHook } from "../security/approval.js";
import { repl, makeReadlineIO } from "./repl.js";
import type { ChatMessage } from "../core/types.js";
import { SessionStore } from "../session/store.js";
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
import { createLogger, initLogger } from "../core/logger.js";

export const log = createLogger("cli");

export interface ParsedCliArgs {
  prompt?: string;
  workdir?: string;
  help?: boolean;
  skipPermissions?: boolean;
  continue?: boolean;
  continueFile?: string;
  cli: Record<string, string>;
}

function stringValue(
  values: Record<string, string | boolean | undefined>,
  key: string,
): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function parseContinue(argv: string[]): { continue?: boolean; continueFile?: string } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--continue") continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      return { continue: true, continueFile: next };
    }
    return { continue: true };
  }
  return {};
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string" },
      "base-url": { type: "string" },
      workdir: { type: "string" },
      "bash-timeout": { type: "string" },
      "max-output-chars": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
    },
    strict: false,
  });

  const model = stringValue(values, "model");
  const baseUrl = stringValue(values, "base-url");
  const bashTimeout = stringValue(values, "bash-timeout");
  const maxOutputChars = stringValue(values, "max-output-chars");
  const workdirValue = stringValue(values, "workdir");
  const prompt = stringValue(values, "print");
  const help = values.help === true;
  const skipPermissions = values["dangerously-skip-permissions"] === true;

  const cli: Record<string, string> = {};
  if (model !== undefined) cli.model = model;
  if (baseUrl !== undefined) cli.base_url = baseUrl;
  if (bashTimeout !== undefined) cli.bash_timeout = bashTimeout;
  if (maxOutputChars !== undefined) cli.max_output_chars = maxOutputChars;
  if (workdirValue !== undefined) cli.workdir = workdirValue;

  return {
    ...(help ? { help } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(workdirValue !== undefined ? { workdir: workdirValue } : {}),
    ...(skipPermissions ? { skipPermissions } : {}),
    ...parseContinue(argv),
    cli,
  };
}

function makeAskUser(rl: readline.Interface): (prompt: string) => Promise<string> {
  return (prompt) =>
    new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
}

export function buildHarness(
  workdir?: string,
  cli?: Record<string, unknown>,
  askUser?: (prompt: string) => Promise<string>,
  skipPermissions = false,
): Harness {
  const config = loadConfig(workdir, cli);
  initLogger(config.workdir);
  const provider = new OpenAIProvider(config);
  const tools = new ToolRegistry();
  const hooks = new HookBus();
  registerBuiltinTools(tools, config);
  const rules = skipPermissions ? SKIP_PERMISSIONS_RULES : DEFAULT_RULES;
  const permissionHook = makePermissionHook(rules, askUser);
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

const USAGE = `usage: blh [-h] [-p PROMPT] [--model MODEL] [--base-url BASE_URL]
            [--workdir WORKDIR] [--bash-timeout BASH_TIMEOUT]
            [--max-output-chars MAX_OUTPUT_CHARS]
            [--dangerously-skip-permissions]

coding agent CLI (TypeScript)

options:
  -p, --print PROMPT    run a single prompt and print the reply
  --model MODEL         model name (overrides OPENAI_MODEL)
  --base-url BASE_URL   OpenAI-compatible base URL (overrides OPENAI_BASE_URL)
  --workdir WORKDIR     working directory
  --bash-timeout N      bash timeout in seconds
  --max-output-chars N  max captured output characters
  --dangerously-skip-permissions
                        allow all bash commands except hard deny rules
  --continue [FILE]     continue a previous session (latest, or FILE in .sessions/)
  -h, --help            show this help message and exit`;

async function main(): Promise<void> {
  const { prompt, workdir, cli, help, skipPermissions, continue: doContinue, continueFile } =
    parseCliArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }
  if (prompt !== undefined) {
    if (!prompt) {
      log.error("usage: blh -p <text>");
      process.exit(1);
    }
    const harness = buildHarness(workdir, cli, undefined, skipPermissions);
    log.info("start", { workdir: harness.config.workdir, model: harness.config.model });
    const messages = harness.newSession();
    await harness.runTurn(messages, prompt);
    console.log(lastAssistantText(messages));
    return;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const harness = buildHarness(workdir, cli, makeAskUser(rl), skipPermissions);
  log.info("start repl", { workdir: harness.config.workdir, model: harness.config.model });

  let messages: ChatMessage[];
  if (doContinue) {
    const file = continueFile
      ? path.join(harness.config.workdir, ".sessions", continueFile)
      : SessionStore.latest(harness.config.workdir);
    if (!file) {
      log.error("no session found to continue");
      process.exit(1);
    }
    harness.sessionStore = SessionStore.open(file);
    messages = harness.newSession();
    messages.push(...SessionStore.load(file));
  } else {
    harness.sessionStore = SessionStore.create(harness.config.workdir);
    messages = harness.newSession();
  }
  await repl(harness, makeReadlineIO(rl), messages);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    log.error("fatal", {}, error);
    process.exit(1);
  });
}
