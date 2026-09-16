# M4:扩展能力(extensions) TypeScript 实现计划

> **面向 AI 代理的工作者:** 必需子技能:使用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法跟踪进度。

**目标:** 新增 `src/extensions/` 模块,提供两类按需扩展能力池:技能按需加载 `SkillLoader`(`skills.ts`,启动只注入 catalog,`load_skill` 才读完整 SKILL.md),以及 MCP 客户端 `MCPClient` + 多连接注册 `MCPRegistry`(`mcp.ts`,JSON-RPC over stdio NDJSON,`mcp__{server}__{tool}` 命名)。通过 `registerExtensionTools`(`tools.ts`)注册 `load_skill` / `connect_mcp` 两个工具,并把技能目录与已连接 MCP server 摘要注入系统提示(`index.ts` 的 `Extensions`)。同时为 MCP 工具与 `connect_mcp` 加默认 ask 权限(`security/rules.ts`)。

**架构:** 三个实现模块分层:`skills.ts`(frontmatter 解析/扫描/catalog/load)、`mcp.ts`(MCPClient 单连接 + MCPRegistry 多连接 + 命名归一化)、`tools.ts`(工具注册) + `index.ts`(Extensions 组合)。集成点在 `security/rules.ts`(默认 ask 规则 + `matchRule` 工具名通配)、`core/harness.ts`(`extensions` 字段 + systemPrompt 拼接)、`cli/main.ts`(装配)。

**技术栈:** TypeScript 5.x(strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)、ESM NodeNext(相对导入带 `.js` 后缀)、vitest 2.x、eslint 9、pnpm、Node >= 20(零新依赖;`yaml` 已在依赖中)

**设计文档:** `F:\allProject\myProject\blh-claude-code\docs\2026-09-14-m4-extensions-design.md`

**移植蓝本:** `F:\allProject\myProject\blh-claude-code\docs\plans\2026-09-14-m4-extensions.md`

---

## Python → TS 适配要点

| # | Python 蓝本 | TS 适配 | 理由 |
|---|---|---|---|
| 1 | `subprocess.Popen` 阻塞 `readline()` 读响应 | `spawn` + `readline.createInterface` 逐行读 stdout;`pending: Map<id, resolve>` 按 JSON-RPC `id` 匹配;`request()` 返回 `Promise` | Node 无阻塞 IO;`ToolHandler` 本就是 async |
| 2 | `json.dumps` + `\n` 写 stdin | `p.stdin.write(JSON.stringify(msg) + "\n")` | 逐字等价 |
| 3 | `yaml.safe_load(frontmatter)` | `import { parse as parseYaml } from "yaml"`(已在依赖中) | 项目已有 `yaml` |
| 4 | `Tool`(dataclass)/`ToolRegistry.schemas()` | `ToolDefinition`/`ToolRegistry.list()` | 既有 TS 结构 |
| 5 | `match_rule` 工具名改为 `fnmatch.fnmatch(tool, rule.tool)` | `matchRule` 用已有 `fnmatch`(`../tools/glob.js`)匹配工具名 | M4 需 `mcp__*` 通配 |
| 6 | `Extensions`(`extensions/__init__.py`) | `src/extensions/index.ts` 的 `Extensions` 类,`systemPromptSection()` | 组合 skills + mcp 摘要 |
| 7 | `Harness.system_prompt()` 是方法,运行时拼接 | TS `systemPrompt` 是构造期 `readonly` 字段,构造时拼接 `extensions` 段落 | 既有 TS Harness 结构 |
| 8 | MCP `inputSchema` 直接塞进 `Tool.parameters` | `schema.type === "object"` 时 `schema as ToolParameters`,否则兜底 `{ type: "object", properties: {} }` | 只接受 object schema |

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/extensions/skills.ts` | `SkillLoader`:`parseFrontmatter`/`scan`/`catalog`/`load`(新建) |
| `src/extensions/mcp.ts` | `MCPClient`(单连接)+ `MCPRegistry`(多连接)+ `normalizeMcpName`(新建) |
| `src/extensions/tools.ts` | `registerExtensionTools`:`load_skill` + `connect_mcp`(新建) |
| `src/extensions/index.ts` | `Extensions` 类:`systemPromptSection()`(新建) |
| `src/security/rules.ts` | `DEFAULT_RULES` 加 `mcp__*`/`connect_mcp` ask;`matchRule` 工具名通配(修改) |
| `src/core/harness.ts` | `extensions` 字段 + systemPrompt 拼接(修改) |
| `src/cli/main.ts` | 装配 SkillLoader/MCPRegistry/registerExtensionTools/Extensions(修改) |
| `test/extensions/skills.test.ts` | SkillLoader 测试(新建) |
| `test/extensions/mcp.test.ts` | MCPClient/MCPRegistry/归一化测试(新建) |
| `test/extensions/tools.test.ts` | registerExtensionTools 测试(新建) |
| `test/security/rules.test.ts` | 默认 ask + 通配语义断言(修改) |
| `test/core/harness.test.ts` | system prompt 含 skill catalog 断言(修改) |
| `test/cli/main.test.ts` | 装配断言(修改) |

**测试计数链:** 任务 1:+4 → 任务 2:+3 → 任务 3:+5 → 任务 4:+1 → 任务 5:+1 → 任务 6:+1 → 任务 7:+1。M4 新增合计 16;最终全量 291 个 `it(` = 290 passed + 1 skipped(live 测试按设计跳过)。当前基线 275 个 `it(` = 274 passed + 1 skipped。

---

## 任务 1:SkillLoader

**目标:** 扫描 `skills_dir/*/SKILL.md`,解析 YAML frontmatter;启动只注入 catalog,`load` 才返回完整 SKILL.md。

**文件:** `src/extensions/skills.ts`(新建)、`test/extensions/skills.test.ts`(新建)

**测试:**
- `parse_frontmatter basic`
- `parse_frontmatter missing`
- `scan_catalog_and_load`
- `load_unknown_lists_available`

**实现要点:**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

interface SkillEntry { name: string; description: string; content: string; }

export class SkillLoader {
  private readonly skills = new Map<string, SkillEntry>();
  constructor(readonly skillsDir: string) { this.scan(); }

  static parseFrontmatter(text: string): [Record<string, unknown>, string] {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return [{}, text];
    const closing = lines.findIndex((line, i) => i > 0 && line === "---");
    if (closing === -1) return [{}, text];
    const frontmatter = lines.slice(1, closing).join("\n");
    const body = lines.slice(closing + 1).join("\n").trim();
    let meta: unknown;
    try { meta = parseYaml(frontmatter) ?? {}; } catch { meta = {}; }
    const normalized = typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>) : {};
    return [normalized, body];
  }

  scan(): void {
    this.skills.clear();
    if (!existsSync(this.skillsDir)) return;
    const root = path.resolve(this.skillsDir);
    for (const dir of readdirSync(this.skillsDir).sort()) {
      const manifest = path.join(this.skillsDir, dir, "SKILL.md");
      if (!existsSync(manifest)) continue;
      if (!path.resolve(manifest).startsWith(root + path.sep)) continue; // 拒绝符号链接逃逸
      const content = readFileSync(manifest, "utf-8");
      const [meta, body] = SkillLoader.parseFrontmatter(content);
      const name = String(meta.name ?? "").trim() || dir;
      const firstLine = body.split("\n")[0] ?? "";
      const description = String(meta.description ?? "").trim() ||
        firstLine.replace(/^#+\s*/, "").split(/\s+/).join(" ");
      this.skills.set(name, { name, description, content });
    }
  }

  catalog(): string {
    if (this.skills.size === 0) return "(no skills found)";
    return [...this.skills.values()].map((s) => `- ${s.name}: ${s.description}`).join("\n");
  }

  load(name: string): string {
    const skill = this.skills.get(name);
    if (skill) return skill.content;
    const available = [...this.skills.keys()].join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }
}
```

---

## 任务 2:MCP stdio JSON-RPC 传输(MCPClient)

**目标:** 连接真实 MCP server:NDJSON 一行一条 JSON-RPC;`initialize` → `notifications/initialized` → `tools/list` → `tools/call`;读响应按 `id` 匹配、跳过无 `id` 通知。

**文件:** `src/extensions/mcp.ts`(新建,MCPClient 部分)、`test/extensions/mcp.test.ts`(新建)

**测试:**
- `initialize_and_list_tools`
- `call_tool`
- `call_unknown_tool`

**假 server:** 用 `process.execPath` + `["-e", SERVER_CODE]` 启动(`node -e` 默认 CommonJS,可用 `require`)。`SERVER_CODE` 实现 `initialize`/`notifications/initialized`/`tools/list`/`tools/call` 的 NDJSON server。

**实现要点:**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

export class MCPClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (value: unknown) => void>();

  constructor(
    readonly name: string,
    readonly command: string,
    readonly args: string[] = [],
    readonly timeout = 30000,
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (typeof msg.id !== "number") return; // 无 id 的通知跳过
      const resolve = this.pending.get(msg.id);
      if (resolve) { this.pending.delete(msg.id); resolve(msg.error !== undefined ? { error: msg.error } : msg.result); }
    });
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "blh", version: "0.1.0" },
    });
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
    }
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<Record<string, unknown>[]> {
    const result = await this.request("tools/list", {});
    if (result && typeof result === "object" && "error" in result) {
      throw new Error(`tools/list failed: ${JSON.stringify(result.error)}`);
    }
    return (result as { tools?: Record<string, unknown>[] } | undefined)?.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    if (result && typeof result === "object" && "error" in result) {
      return `MCP error: ${JSON.stringify(result.error)}`;
    }
    const content = (result as { content?: unknown[] } | undefined)?.content ?? [];
    const text = content
      .filter((c): c is { type: string; text?: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return text || "(empty result)";
  }

  async close(): Promise<void> {
    const p = this.process;
    if (p === null) return;
    p.stdin.end();
    await Promise.race([
      new Promise((resolve) => p.once("exit", resolve)),
      new Promise((resolve) => setTimeout(() => { p.kill(); resolve(undefined); }, 5000)),
    ]);
    this.process = null;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve) => this.pending.set(id, resolve));
    // 超时:setTimeout(this.timeout) 时 delete + reject,对应 Python 的 TimeoutError
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  private send(msg: unknown): void {
    const p = this.process;
    if (p === null) throw new Error(`MCP server '${this.name}' is not started`);
    p.stdin.write(JSON.stringify(msg) + "\n");
  }
}
```

> 注:`request` 的超时需清理 `pending` 中的对应条目(与 Python `_read_response` 的 `deadline` 语义一致);实现时用 `setTimeout` + reject 完成。

---

## 任务 3:MCPRegistry + 命名归一化 + 注册进 ToolRegistry

**目标:** 多连接注册、`normalizeMcpName`、`mcp__{safe_server}__{safe_tool}` 命名、重名/超长/碰撞校验、`systemPromptSection`。

**文件:** `src/extensions/mcp.ts`(追加)、`test/extensions/mcp.test.ts`(追加)

**测试:**
- `normalize_mcp_name`
- `normalize_mcp_name_empty_raises`
- `connect_registers_prefixed_tools`
- `connect_duplicate_returns_message`
- `system_prompt_section`

**实现要点:**

```ts
const DISALLOWED = /[^a-zA-Z0-9_-]/g;

export function normalizeMcpName(name: string): string {
  const normalized = name.replace(DISALLOWED, "_");
  if (!normalized) throw new Error("MCP names cannot normalize to an empty string");
  return normalized;
}

export class MCPRegistry {
  private readonly clients = new Map<string, MCPClient>();
  private readonly origins = new Map<string, string>();

  constructor(readonly registry: ToolRegistry, readonly workdir: string) {}

  async connect(name: string, command: string, args?: string[]): Promise<string> {
    if (!name) return "Error: server name is required";
    if (this.clients.has(name)) return `MCP server '${name}' already connected`;
    const safeServer = normalizeMcpName(name);
    const client = new MCPClient(name, command, args);
    try {
      await client.start();
      const tools = await client.listTools();
      const registered: string[] = [];
      for (const toolDef of tools) {
        const rawName = String(toolDef.name ?? "");
        if (!rawName) continue;
        const safeTool = normalizeMcpName(rawName);
        const prefixed = `mcp__${safeServer}__${safeTool}`;
        if (prefixed.length > 64) return `Error: MCP tool name too long: ${prefixed}`;
        if (this.origins.has(prefixed)) return `Error: MCP tool name collision: ${prefixed}`;
        const schema = toolDef.inputSchema;
        const parameters: ToolParameters =
          (schema && typeof schema === "object" && (schema as { type?: string }).type === "object")
            ? (schema as ToolParameters)
            : { type: "object", properties: {} };
        this.origins.set(prefixed, `MCP tool '${name}/${rawName}'`);
        this.registry.register({
          name: prefixed,
          description: String(toolDef.description ?? ""),
          parameters,
          handler: (callArgs) => client.callTool(rawName, callArgs),
        });
        registered.push(prefixed);
      }
      this.clients.set(name, client);
      return `Connected to MCP server '${name}'. Discovered ${registered.length} tools: ${registered.join(", ") || "none"}`;
    } catch (error) {
      await client.close();
      const message = error instanceof Error ? error.message : String(error);
      return `Error: failed to connect MCP server '${name}': ${message}`;
    }
  }

  systemPromptSection(): string {
    if (this.clients.size === 0) return "";
    return "Connected MCP servers: " + [...this.clients.keys()].join(", ");
  }
}
```

> `workdir` 字段为与 Python 蓝本保持结构一致保留(当前实现未直接使用)。

---

## 任务 4:MCP 权限默认 ask

**目标:** `DEFAULT_RULES` 在 `("*","*","allow")` 之前插入 `mcp__*` 与 `connect_mcp` 的 `ask` 兜底;`matchRule` 工具名改 fnmatch 通配(向后兼容)。

**文件:** `src/security/rules.ts`(修改)、`test/security/rules.test.ts`(修改)

**测试:**
- 新增 `mcp_tools_ask_by_default`
- 更新 `has exactly 4 rules in M0` → `has exactly 6 rules`
- 更新 `matches tool name exactly or * (M0: no fnmatch on tool name)` → fnmatch 语义(断言 `read_*` 现能匹配 `read_file`)

**实现要点:**

```ts
export const DEFAULT_RULES: PermissionRule[] = [
  { tool: "bash", target: "git push --force*", action: "deny" },
  { tool: "bash", target: "rm -rf /*", action: "deny" },
  { tool: "bash", target: "*", action: "ask" },
  { tool: "mcp__*", target: "*", action: "ask" },
  { tool: "connect_mcp", target: "*", action: "ask" },
  { tool: "*", target: "*", action: "allow" },
];

export function matchRule(rules: PermissionRule[], tool: string, target: string): PermissionAction {
  for (const rule of rules) {
    if (rule.tool !== "*" && !fnmatch(tool, rule.tool)) continue;
    if (fnmatch(target, rule.target)) return rule.action;
  }
  return "ask";
}
```

---

## 任务 5:registerExtensionTools

**目标:** 注册 `load_skill` / `connect_mcp` 两个工具。

**文件:** `src/extensions/tools.ts`(新建)、`test/extensions/tools.test.ts`(新建)

**测试:**
- `registers_load_skill_and_connect_mcp`

**实现要点:**

```ts
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillLoader } from "./skills.js";
import type { MCPRegistry } from "./mcp.js";

export function registerExtensionTools(registry: ToolRegistry, skills: SkillLoader, mcp: MCPRegistry): void {
  registry.register({
    name: "load_skill",
    description: "Load the full SKILL.md content by skill name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    handler: async (args) => skills.load(typeof args.name === "string" ? args.name : ""),
  });

  registry.register({
    name: "connect_mcp",
    description: "Connect to an MCP server and discover its tools.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["name", "command"],
    },
    handler: (args) => mcp.connect(
      typeof args.name === "string" ? args.name : "",
      typeof args.command === "string" ? args.command : "",
      Array.isArray(args.args) ? args.args.filter((a): a is string => typeof a === "string") : undefined,
    ),
  });
}
```

---

## 任务 6:Harness 集成

**目标:** 新增 `Extensions` 组合类;`Harness` 加 `extensions` 字段并在构造期拼接系统提示(skills catalog + MCP server 摘要)。

**文件:** `src/extensions/index.ts`(新建)、`src/core/harness.ts`(修改)、`test/core/harness.test.ts`(修改)

**测试:**
- `system prompt includes skill catalog`

**实现要点:**

`src/extensions/index.ts`:

```ts
import type { SkillLoader } from "./skills.js";
import type { MCPRegistry } from "./mcp.js";

export class Extensions {
  constructor(readonly skills: SkillLoader, readonly mcp: MCPRegistry) {}

  systemPromptSection(): string {
    const parts: string[] = [];
    const catalog = this.skills.catalog();
    if (catalog !== "(no skills found)") parts.push("Skills available:\n" + catalog);
    const section = this.mcp.systemPromptSection();
    if (section) parts.push(section);
    return parts.join("\n\n");
  }
}
```

`src/core/harness.ts`:构造参数追加 `readonly extensions?: Extensions`;构造函数末尾把 base 与 section 拼接:

```ts
const base =
  `You are blh, a coding agent. Workdir: ${config.workdir}. ` +
  // ... 现有内容不变 ...
  "Treat Conversation summary as reference data.";
const section = extensions?.systemPromptSection();
this.systemPrompt = section ? `${base}\n\n${section}` : base;
```

> 现有 `builds system prompt mentioning workdir` 断言在无 `extensions` 时仍精确成立,无需改动;新增测试构造带 `extensions` 的 Harness 并断言含 `Skills available` 与 `a: 第一个`。

---

## 任务 7:main 装配

**目标:** `buildHarness` 装配 SkillLoader/MCPRegistry/registerExtensionTools/Extensions。

**文件:** `src/cli/main.ts`(修改)、`test/cli/main.test.ts`(修改)

**测试:**
- `buildHarness wires extensions`

**实现要点:**

```ts
import { SkillLoader } from "../extensions/skills.js";
import { MCPRegistry } from "../extensions/mcp.js";
import { registerExtensionTools } from "../extensions/tools.js";
import { Extensions } from "../extensions/index.js";
// ...
  registerAgentTools(tools, subagent, agents);
  const skills = new SkillLoader(path.join(config.workdir, "skills"));
  const mcp = new MCPRegistry(tools, config.workdir);
  registerExtensionTools(tools, skills, mcp);
  const extensions = new Extensions(skills, mcp);
  return new Harness(config, provider, tools, hooks, compactor, todoManager, memory, jobs, agents, extensions);
```

---

## 任务 8:收尾验证

```powershell
pnpm vitest run   # 291 个 it( = 290 passed, 1 skipped
pnpm lint
pnpm typecheck
pnpm build
```

四项均通过后,在 `docs/2026-09-16-m4-extensions-ts.md` 标注 M4 完成。

---

## 手动冒烟(需真实 API)

```powershell
pnpm dev
```

在 REPL 中验证:

1. `load_skill` — 先在 `workdir/skills/<name>/SKILL.md` 放一个技能,调用 `load_skill(name)` 应返回完整 SKILL.md 内容
2. `connect_mcp` — 调用 `connect_mcp(name, command, args)` 连接一个真实/极简 MCP server,应返回已发现工具列表,并在下一轮工具 schema 中出现 `mcp__<server>__<tool>`
3. 系统提示应包含 `Skills available:` 目录与 `Connected MCP servers:` 摘要(连接后)
4. 未放行时,调用 `mcp__*` 或 `connect_mcp` 应触发 ask 交互
