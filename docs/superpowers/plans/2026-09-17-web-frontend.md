# Web 前端（交互式工作台）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 blh-claude-code-ts 新增一个 web 交互式工作台（聊天 + 工具可视化 + 权限审批 + 会话历史），通过 `blh web` 子命令启动。

**架构：** 复用现有 `buildHarness` / `agentLoop` / `EventBus` / `SessionStore`，新增 `src/server/`（node:http 服务器 + SSE + 会话管理 + 审批），前端用 React + Vite（`apps/web`），共享类型/客户端在 `packages/web-client`。通信用 SSE（服务器→浏览器）+ HTTP（浏览器→服务器），仅监听 127.0.0.1。

**技术栈：** Node `node:http`、React 18、Vite、TypeScript（NodeNext）、vitest、Playwright。

---

## 文件结构

**工程基础（任务 1）**
- 修改 `pnpm-workspace.yaml`：声明 `packages: ["packages/*", "apps/*"]`。
- 修改 `.gitignore`：新增 `.superpowers/`。
- 创建 `packages/web-client/package.json` + `packages/web-client/tsconfig.json`：共享类型/客户端包。
- 创建 `apps/web/package.json` + `apps/web/tsconfig.json` + `apps/web/vite.config.ts` + `apps/web/index.html` + `apps/web/src/vite-env.d.ts`：React 前端脚手架。

**审批泛化（任务 2）**
- 修改 `src/security/rules.ts`：新增 `insertUserRule` 辅助函数。
- 修改 `src/security/approval.ts`：泛化 `makePermissionHook`（结构化 asker + `persistRule`）。
- 修改 `src/cli/main.ts`：`makeAskUser` 适配新接口、`buildHarness` 增加权限选项参数。

**web 后端（任务 3–7）**
- 创建 `src/server/bridge.ts`：`WebEvent` 类型 + `SSEBroadcaster`（SSE 广播）。
- 创建 `src/server/approval.ts`：`ApprovalCoordinator`（审批 pending 队列）+ 用户规则读写。
- 创建 `src/server/session.ts`：`SessionManager`（单会话管理，接口预留多会话）。
- 创建 `src/server/http.ts`：node:http 服务器 + 路由 + SSE 端点 + 静态文件。
- 创建 `src/server/index.ts`：`startWebServer` 汇总入口。
- 创建 `src/cli/harness.ts`：抽出 `buildHarness`（避免 cli ↔ server 循环导入）。
- 修改 `src/cli/main.ts`：新增 `blh web` 子命令分支，改从 `./harness.js` 导入并 re-export `buildHarness`。

**共享客户端（任务 8）**
- 创建 `packages/web-client/src/types.ts`：SSE 事件类型 + API 类型。
- 创建 `packages/web-client/src/sse.ts`：`EventSource` 封装。
- 创建 `packages/web-client/src/api.ts`：`fetch` 封装。
- 创建 `packages/web-client/src/index.ts`：统一导出。

**React 前端（任务 9–11）**
- 创建 `apps/web/src/hooks/useAgentEvents.ts`、`apps/web/src/main.tsx`、`apps/web/src/App.tsx`、`apps/web/src/styles.css`。
- 创建 `apps/web/src/components/ChatPanel.tsx`、`ToolCallCard.tsx`、`InputBar.tsx`、`ApprovalModal.tsx`、`SessionSidebar.tsx`。

**构建与 e2e（任务 12–13）**
- 修改根包 `package.json`：新增 `build:web` 脚本。
- 创建 `apps/web/playwright.config.ts` + `apps/web/e2e/workbench.spec.ts` + `apps/web/e2e/mock-server.mjs`；`apps/web/package.json` 增加 `@playwright/test` 与 `test:e2e` 脚本。

---

### 任务 1：pnpm workspace 工程基础

**文件：**
- 修改：`pnpm-workspace.yaml`
- 修改：`.gitignore`
- 创建：`packages/web-client/package.json`
- 创建：`packages/web-client/tsconfig.json`
- 创建：`apps/web/package.json`
- 创建：`apps/web/tsconfig.json`
- 创建：`apps/web/vite.config.ts`
- 创建：`apps/web/index.html`

- [ ] **步骤 1：声明 workspace 包**

修改 `pnpm-workspace.yaml`，在 `cacheDir` 后插入 `packages` 字段：

```yaml
storeDir: .pnpm-store
cacheDir: .pnpm-cache
packages:
  - "packages/*"
  - "apps/*"
onlyBuiltDependencies:
  - esbuild
allowBuilds:
  esbuild: true
```

- [ ] **步骤 2：更新 .gitignore**

在 `.gitignore` 末尾追加一行：

```
.superpowers/
```

（`apps/web/dist/` 与 `apps/web/node_modules/` 已被现有的 `dist/`、`node_modules/` 规则覆盖，无需重复。）

- [ ] **步骤 3：创建 web-client 包清单**

创建 `packages/web-client/package.json`（源文件型包，无构建步骤，由 Vite 直接消费 TS 源码）：

```json
{
  "name": "@blh/web-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **步骤 4：创建 web-client 的 tsconfig**

创建 `packages/web-client/tsconfig.json`（复用根目录严格配置，只做类型检查不产出）：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **步骤 5：创建 apps/web 包清单**

创建 `apps/web/package.json`：

```json
{
  "name": "@blh/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "@blh/web-client": "workspace:*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **步骤 6：创建 apps/web 的 tsconfig**

创建 `apps/web/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@blh/web-client": ["../../packages/web-client/src/index.ts"]
    }
  },
  "include": ["src", "e2e", "playwright.config.ts", "vite.config.ts"]
}
```

- [ ] **步骤 7：创建 Vite 配置**

创建 `apps/web/vite.config.ts`（用 alias 让 Vite 直接消费 web-client 的 TS 源码）：

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@blh/web-client": path.resolve(root, "../../packages/web-client/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8123",
        changeOrigin: true,
      },
    },
  },
  build: {
    // 产出到根 dist/web，与 server/index.ts 的 staticDir() 对齐
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
```

- [ ] **步骤 8：创建 index.html**

创建 `apps/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>blh 工作台</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

同时创建 `apps/web/src/vite-env.d.ts`（让 TS 识别 `.css` / `import.meta.env` 等 Vite 类型）：

```ts
/// <reference types="vite/client" />
```

- [ ] **步骤 9：安装依赖并验证类型**

运行：

```bash
pnpm install
pnpm --filter @blh/web-client typecheck
```

预期：`pnpm install` 成功解析 workspace 链接；`typecheck` 通过（此时 `src/index.ts` 尚未创建会报错，见任务 8；本任务先跑 `pnpm install` 确认 workspace 生效）。

- [ ] **步骤 10：Commit**

```bash
git add pnpm-workspace.yaml .gitignore packages/web-client apps/web
git commit -m "chore: add pnpm workspace scaffolding for web frontend"
```

---

### 任务 2：审批泛化（结构化 asker + 「总是允许」）

**文件：**
- 修改：`src/security/rules.ts`
- 修改：`src/security/approval.ts`
- 修改：`src/cli/main.ts`
- 修改：`test/integration/agent.test.ts:40`
- 创建：`test/security/approval.test.ts`
- 修改：`test/security/rules.test.ts`

- [ ] **步骤 1：编写失败的测试（rules）**

在 `test/security/rules.test.ts` 顶部 import 处新增 `insertUserRule`，并在文件末尾追加：

```ts
import { insertUserRule, matchRule, DEFAULT_RULES, SKIP_PERMISSIONS_RULES } from "../../src/security/rules.js";

describe("insertUserRule", () => {
  it("插入到硬性 deny 之后、默认 ask 之前", () => {
    const rules = [...DEFAULT_RULES];
    insertUserRule(rules, { tool: "bash", target: "ls -la", action: "allow" });
    const denyIdx = rules.findIndex((r) => r.action === "deny");
    const askIdx = rules.findIndex((r) => r.action === "ask");
    const userIdx = rules.findIndex((r) => r.target === "ls -la");
    expect(denyIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(denyIdx);
    expect(userIdx).toBeLessThan(askIdx);
  });
});
```

- [ ] **步骤 2：编写失败的测试（approval）**

创建 `test/security/approval.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { makePermissionHook } from "../../src/security/approval.js";
import { DEFAULT_RULES, type PermissionRule } from "../../src/security/rules.js";

describe("makePermissionHook（结构化 asker）", () => {
  it("asker 返回 allow 时放行", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "allow");
    expect(await hook("bash", { command: "ls" })).toBeNull();
  });

  it("asker 返回 deny 时阻断", async () => {
    const hook = makePermissionHook(DEFAULT_RULES, async () => "deny");
    expect(await hook("bash", { command: "ls" })).toBe("denied by user");
  });

  it("asker 拿到结构化的 tool/target/args", async () => {
    let received: unknown;
    const hook = makePermissionHook(DEFAULT_RULES, async (req) => {
      received = req;
      return "deny";
    });
    await hook("bash", { command: "npm install" });
    expect(received).toEqual({
      tool: "bash",
      target: "npm install",
      args: { command: "npm install" },
    });
  });

  it("always_allow 写入规则并回调 persistRule，且不覆盖硬性 deny", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));

    expect(await hook("bash", { command: "ls -la" })).toBeNull();
    const denyIdx = rules.findIndex((r) => r.action === "deny");
    const userIdx = rules.findIndex((r) => r.target === "ls -la");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(denyIdx).toBeLessThan(userIdx);
    expect(persisted).toEqual([{ tool: "bash", target: "ls -la", action: "allow" }]);
  });

  it("always_allow 且 target 为空时退化为放行、不写规则", async () => {
    const rules = [...DEFAULT_RULES];
    const persisted: PermissionRule[] = [];
    const hook = makePermissionHook(rules, async () => "always_allow", (r) => persisted.push(r));
    expect(await hook("bash", {})).toBeNull();
    expect(persisted).toEqual([]);
    expect(rules.length).toBe(DEFAULT_RULES.length);
  });
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：

```bash
pnpm test test/security/rules.test.ts test/security/approval.test.ts
```

预期：FAIL，报错 `insertUserRule` 不存在、`makePermissionHook` 的 asker 参数类型不匹配。

- [ ] **步骤 4：实现 rules.ts 的 insertUserRule**

在 `src/security/rules.ts` 的 `matchRule` 之后追加：

```ts
/** 把用户规则插到硬性 deny 之后、默认 ask/allow 之前。 */
export function insertUserRule(rules: PermissionRule[], rule: PermissionRule): void {
  const idx = rules.findIndex((r) => r.action !== "deny");
  rules.splice(idx === -1 ? rules.length : idx, 0, rule);
}
```

- [ ] **步骤 5：泛化 approval.ts**

把 `src/security/approval.ts` 整体替换为：

```ts
import type { PermissionRule } from "./rules.js";
import { insertUserRule, matchRule } from "./rules.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("security.approval");

export interface ApprovalRequest {
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export type ApprovalAsker = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** PreToolUse hook：返回 null 放行；返回字符串则阻断并作为工具结果 */
export type PermissionHook = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<string | null>;

/** scheduled turn 上下文标志 */
export const approvalContext = { scheduledTurn: false };

export function makePermissionHook(
  rules: PermissionRule[],
  ask?: ApprovalAsker,
  persistRule?: (rule: PermissionRule) => void,
): PermissionHook {
  const asker: ApprovalAsker = ask ?? (async () => "deny");

  return async (tool, args) => {
    const target =
      (typeof args.command === "string" && args.command) ||
      (typeof args.path === "string" && args.path) ||
      "";
    const action = matchRule(rules, tool, target);
    if (action === "allow") return null;
    if (action === "deny") {
      log.warn("denied by rule", { tool, target });
      return `denied by permission rule (${tool}: ${target})`;
    }
    if (approvalContext.scheduledTurn) {
      return "denied: cannot request approval from a scheduled turn";
    }
    const decision = await asker({ tool, target, args });
    if (decision === "deny") {
      log.warn("denied by user", { tool, target });
      return "denied by user";
    }
    if (decision === "always_allow" && target !== "") {
      const rule: PermissionRule = { tool, target, action: "allow" };
      insertUserRule(rules, rule);
      persistRule?.(rule);
      log.debug("always allowed", { tool, target });
    } else {
      log.debug("approved", { tool, target });
    }
    return null;
  };
}
```

- [ ] **步骤 6：适配 CLI 的 makeAskUser 与 buildHarness**

在 `src/cli/main.ts` 中：

1. 把 `makePermissionHook` 的 import 行改为：

```ts
import { makePermissionHook, type ApprovalAsker, type ApprovalDecision } from "../security/approval.js";
```

2. 把 `rules.js` 的 import 行改为：

```ts
import { DEFAULT_RULES, SKIP_PERMISSIONS_RULES, insertUserRule, type PermissionRule } from "../security/rules.js";
```

3. 把 `makeAskUser` 替换为：

```ts
/** 造一个"问用户"的函数：弹出问题，等用户在终端里输入答案。 */
function makeAskUser(rl: readline.Interface): ApprovalAsker {
  return (req) =>
    new Promise<ApprovalDecision>((resolve) => {
      rl.question(`allow ${req.tool}(${req.target})? [y/N] `, (answer) => {
        const a = answer.trim().toLowerCase();
        resolve(a === "y" || a === "yes" ? "allow" : "deny");
      });
    });
}
```

4. 把 `buildHarness` 签名与 rules 装配改为：

```ts
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
  // ...其余保持不变
}
```

- [ ] **步骤 7：适配既有集成测试**

把 `test/integration/agent.test.ts:40` 的：

```ts
const permissionHook = makePermissionHook(DEFAULT_RULES, async () => askAnswer);
```

改为：

```ts
const permissionHook = makePermissionHook(DEFAULT_RULES, async () =>
  askAnswer === "y" ? "allow" : "deny",
);
```

- [ ] **步骤 8：运行测试验证通过**

运行：

```bash
pnpm test test/security/rules.test.ts test/security/approval.test.ts test/integration/agent.test.ts
```

预期：全部 PASS。

- [ ] **步骤 9：全量回归**

运行：

```bash
pnpm typecheck
pnpm test
```

预期：typecheck 通过；全部测试 PASS（CLI 行为不变）。

- [ ] **步骤 10：Commit**

```bash
git add src/security/rules.ts src/security/approval.ts src/cli/main.ts test/security/rules.test.ts test/security/approval.test.ts test/integration/agent.test.ts
git commit -m "refactor(security): generalize permission approval for web asker"
```

### 任务 3：SSE 桥接（WebEvent + SSEBroadcaster）

**文件：**
- 创建：`src/server/bridge.ts`
- 测试：`test/server/bridge.test.ts`

`bridge.ts` 是服务器推送给浏览器的唯一事件类型与广播器。`WebEvent` 复用现有 `AgentEvent`（`turn_start` / `assistant_text_delta` / `tool_call` / `tool_result` / `turn_end`），另加 `approval_requested` 与 `error` 两类。

- [ ] **步骤 1：编写失败的测试**

创建 `test/server/bridge.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { serializeEvent, SSEBroadcaster, type WebEvent } from "../../src/server/bridge.js";

describe("serializeEvent", () => {
  it("序列化文本增量", () => {
    const event: WebEvent = { type: "assistant_text_delta", text: "你好" };
    expect(serializeEvent(event)).toBe('event: assistant_text_delta\ndata: {"text":"你好"}\n\n');
  });

  it("序列化无载荷事件", () => {
    expect(serializeEvent({ type: "turn_start" })).toBe("event: turn_start\ndata: {}\n\n");
  });

  it("序列化审批事件", () => {
    const event: WebEvent = {
      type: "approval_requested",
      requestId: "r1",
      tool: "bash",
      target: "ls",
      args: { command: "ls" },
    };
    expect(serializeEvent(event)).toBe(
      'event: approval_requested\ndata: {"requestId":"r1","tool":"bash","target":"ls","args":{"command":"ls"}}\n\n',
    );
  });
});

describe("SSEBroadcaster", () => {
  it("订阅后广播、取消订阅后不再广播", () => {
    const broadcaster = new SSEBroadcaster();
    const write = vi.fn();
    const res = { writeHead: vi.fn(), write, end: vi.fn() } as unknown as ServerResponse;

    const off = broadcaster.subscribe(res);
    expect(broadcaster.clientCount).toBe(1);
    broadcaster.broadcast({ type: "turn_end" });

    off();
    expect(broadcaster.clientCount).toBe(0);
    broadcaster.broadcast({ type: "turn_end" });

    const frames = write.mock.calls.map((c) => c[0] as string);
    expect(frames.filter((f) => f.includes("event: turn_end"))).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm test test/server/bridge.test.ts
```

预期：FAIL，报错找不到 `../../src/server/bridge.js`。

- [ ] **步骤 3：实现 bridge.ts**

创建 `src/server/bridge.ts`：

```ts
import type { ServerResponse } from "node:http";
import type { AgentEvent } from "../core/events.js";

/** 服务器推给浏览器的所有事件：复用 agent 高层事件，另加审批与错误两类。 */
export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "error"; message: string };

/** 把一条事件序列化成 SSE 帧（event: <type> + data: <json>）。纯函数，便于单测。 */
export function serializeEvent(event: WebEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 维护当前所有 SSE 连接并广播事件。 */
export class SSEBroadcaster {
  private readonly clients = new Set<ServerResponse>();

  /** 接入一个新 SSE 客户端，返回取消订阅函数（会 end 连接）。 */
  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    return () => {
      this.clients.delete(res);
      res.end();
    };
  }

  broadcast(event: WebEvent): void {
    const frame = serializeEvent(event);
    for (const client of this.clients) client.write(frame);
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm test test/server/bridge.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/server/bridge.ts test/server/bridge.test.ts
git commit -m "feat(server): add SSE broadcaster bridging agent events to web"
```

---

### 任务 4：审批协调器 + 用户规则持久化

**文件：**
- 创建：`src/server/approval.ts`
- 测试：`test/server/approval.test.ts`

`approval.ts` 做两件事：(1) 读写 `.blh/user-rules.json`（「总是允许」落盘）；(2) `ApprovalCoordinator` 管理待审批请求——web 的 asker 调 `ask()` 挂起一个 Promise，HTTP 端调 `resolve()` 应答。

- [ ] **步骤 1：编写失败的测试**

创建 `test/server/approval.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalCoordinator, loadUserRules, persistUserRule, userRulesPath } from "../../src/server/approval.js";
import type { WebEvent } from "../../src/server/bridge.js";

describe("user rules 持久化", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-rules-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("无文件时返回空数组", () => {
    expect(loadUserRules(tmpDir)).toEqual([]);
  });

  it("写入后能读回并追加", () => {
    persistUserRule(tmpDir, { tool: "bash", target: "ls", action: "allow" });
    persistUserRule(tmpDir, { tool: "bash", target: "cat", action: "allow" });
    expect(loadUserRules(tmpDir)).toEqual([
      { tool: "bash", target: "ls", action: "allow" },
      { tool: "bash", target: "cat", action: "allow" },
    ]);
  });

  it("非法条目被过滤", () => {
    writeFileSync(
      userRulesPath(tmpDir),
      JSON.stringify([{ tool: "bash" }, "oops", { tool: "bash", target: "ls", action: "allow" }]),
    );
    expect(loadUserRules(tmpDir)).toEqual([{ tool: "bash", target: "ls", action: "allow" }]);
  });
});

describe("ApprovalCoordinator", () => {
  it("ask 广播审批事件，resolve 应答对应请求", async () => {
    const events: WebEvent[] = [];
    const coordinator = new ApprovalCoordinator((e) => events.push(e));
    const promise = coordinator.ask({ tool: "bash", target: "ls", args: { command: "ls" } });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "approval_requested", tool: "bash", target: "ls" });
    const requestId = (events[0] as { requestId: string }).requestId;

    expect(coordinator.resolve(requestId, "always_allow")).toBe(true);
    await expect(promise).resolves.toBe("always_allow");
  });

  it("resolve 未知 id 返回 false", () => {
    const coordinator = new ApprovalCoordinator(() => {});
    expect(coordinator.resolve("nope", "allow")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm test test/server/approval.test.ts
```

预期：FAIL，报错找不到 `../../src/server/approval.js`。

- [ ] **步骤 3：实现 approval.ts**

创建 `src/server/approval.ts`：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { PermissionRule } from "../security/rules.js";
import type { ApprovalDecision, ApprovalRequest } from "../security/approval.js";
import type { WebEvent } from "./bridge.js";

const RULES_FILE = "user-rules.json";

export function userRulesPath(workdir: string): string {
  return path.join(workdir, ".blh", RULES_FILE);
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tool === "string" &&
    typeof r.target === "string" &&
    (r.action === "allow" || r.action === "deny" || r.action === "ask")
  );
}

/** 读取 .blh/user-rules.json；文件不存在或非法时返回空数组。 */
export function loadUserRules(workdir: string): PermissionRule[] {
  const file = userRulesPath(workdir);
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPermissionRule);
  } catch {
    return [];
  }
}

/** 把一条新规则追加进 .blh/user-rules.json（整体覆写）。 */
export function persistUserRule(workdir: string, rule: PermissionRule): void {
  const file = userRulesPath(workdir);
  mkdirSync(path.dirname(file), { recursive: true });
  const rules = loadUserRules(workdir);
  rules.push(rule);
  writeFileSync(file, JSON.stringify(rules, null, 2) + "\n", "utf8");
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

/** 管理待审批请求：web asker 调 ask() 挂起，HTTP 端 resolve() 应答；超时默认拒绝。 */
export class ApprovalCoordinator {
  private seq = 0;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly broadcast: (event: WebEvent) => void) {}

  ask(req: ApprovalRequest): Promise<ApprovalDecision> {
    const requestId = `approval_${++this.seq}`;
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("deny");
      }, 5 * 60 * 1000);
      timer.unref();
      this.pending.set(requestId, { resolve, timer });
      this.broadcast({
        type: "approval_requested",
        requestId,
        tool: req.tool,
        target: req.target,
        args: req.args,
      });
    });
  }

  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm test test/server/approval.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/server/approval.ts test/server/approval.test.ts
git commit -m "feat(server): add approval coordinator and user-rules persistence"
```

---

### 任务 5：会话管理（SessionManager）

**文件：**
- 创建：`src/server/session.ts`
- 测试：`test/server/session.test.ts`

`SessionManager` 用最小接口（`WebTurnRunner` + `TurnLock`，`Harness` 与 `JobsRuntime.agentLock` 都满足）管理「当前会话」。当前是单会话；未来多会话时把 `current` 换成 `Map<id, handle>`。

- [ ] **步骤 1：编写失败的测试**

创建 `test/server/session.test.ts`：

```ts
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type TurnLock, type WebTurnRunner } from "../../src/server/session.js";
import { SessionStore } from "../../src/session/store.js";
import { ApprovalCoordinator } from "../../src/server/approval.js";
import type { ChatMessage } from "../../src/core/types.js";
import type { WebEvent } from "../../src/server/bridge.js";

function fakeLock(): TurnLock {
  return { withLock: async <T,>(fn: () => Promise<T>) => fn() };
}

function fakeRunner(): WebTurnRunner {
  return {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: vi.fn(async (messages: ChatMessage[], text: string) => {
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: `reply:${text}` });
    }),
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-session-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("SessionManager", () => {
  it("create 建立会话并挂到 runner", () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);

    expect(handle.messages).toEqual([{ role: "system", content: "sys" }]);
    expect(runner.sessionStore?.path).toBe(handle.file);
    expect(manager.list()).toEqual([handle]);
    expect(manager.get(handle.id)).toBe(handle);
  });

  it("runTurn 在锁内跑轮次", async () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);

    await manager.runTurn(handle.id, "hi");
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    expect(handle.messages.map((m) => m.content)).toContain("reply:hi");
  });

  it("resume 载入历史消息并继续同一文件", () => {
    const runner = fakeRunner();
    const manager = new SessionManager(runner, fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const store = SessionStore.create(tmpDir);
    store.append({ role: "user", content: "old" });

    const handle = manager.resume(tmpDir, path.basename(store.path));
    expect(handle.messages.map((m) => m.content)).toEqual(["sys", "old"]);
    expect(runner.sessionStore?.path).toBe(store.path);
  });

  it("approve 应答待审批请求", async () => {
    const events: WebEvent[] = [];
    const approvals = new ApprovalCoordinator((e) => events.push(e));
    const manager = new SessionManager(fakeRunner(), fakeLock(), (e) => events.push(e), approvals);

    const promise = approvals.ask({ tool: "bash", target: "ls", args: {} });
    const requestId = (events[0] as { requestId: string }).requestId;
    expect(manager.approve(requestId, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");
  });

  it("dispose 清空当前会话", () => {
    const manager = new SessionManager(fakeRunner(), fakeLock(), () => {}, new ApprovalCoordinator(() => {}));
    const handle = manager.create(tmpDir);
    return manager.dispose(handle.id).then(() => {
      expect(manager.list()).toEqual([]);
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm test test/server/session.test.ts
```

预期：FAIL，报错找不到 `../../src/server/session.js`。

- [ ] **步骤 3：实现 session.ts**

创建 `src/server/session.ts`：

```ts
import * as path from "node:path";
import type { ChatMessage } from "../core/types.js";
import { EventBus } from "../core/events.js";
import { SessionStore } from "../session/store.js";
import type { ApprovalDecision } from "../security/approval.js";
import type { WebEvent } from "./bridge.js";
import type { ApprovalCoordinator } from "./approval.js";

/** SessionManager 依赖的最小会话运行接口（Harness 满足）。 */
export interface WebTurnRunner {
  newSession(): ChatMessage[];
  runTurn(messages: ChatMessage[], text: string, events?: EventBus): Promise<void>;
  sessionStore?: SessionStore | undefined;
}

/** 串行化跑轮次的锁（JobsRuntime.agentLock 满足）。 */
export interface TurnLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface SessionHandle {
  id: string;
  file: string;
  messages: ChatMessage[];
  store: SessionStore;
}

/** 会话管理：当前单会话实现；接口按多会话可扩展（未来换成 Map<id, handle>）。 */
export class SessionManager {
  private current: SessionHandle | undefined;

  constructor(
    private readonly runner: WebTurnRunner,
    private readonly lock: TurnLock,
    private readonly broadcast: (event: WebEvent) => void,
    private readonly approvals: ApprovalCoordinator,
  ) {}

  create(workdir: string): SessionHandle {
    const store = SessionStore.create(workdir);
    this.runner.sessionStore = store;
    const handle: SessionHandle = {
      id: path.basename(store.path),
      file: store.path,
      messages: this.runner.newSession(),
      store,
    };
    this.current = handle;
    return handle;
  }

  resume(workdir: string, file: string): SessionHandle {
    const fullPath = path.join(SessionStore.sessionsDir(workdir), file);
    const store = SessionStore.open(fullPath);
    this.runner.sessionStore = store;
    const messages = this.runner.newSession();
    messages.push(...SessionStore.load(fullPath));
    const handle: SessionHandle = { id: file, file: fullPath, messages, store };
    this.current = handle;
    return handle;
  }

  get(id: string): SessionHandle | undefined {
    return this.current !== undefined && this.current.id === id ? this.current : undefined;
  }

  list(): SessionHandle[] {
    return this.current !== undefined ? [this.current] : [];
  }

  runTurn(id: string, text: string): Promise<void> {
    const handle = this.get(id);
    if (handle === undefined) return Promise.reject(new Error(`no such session: ${id}`));
    const events = new EventBus();
    const off = events.subscribe((event) => this.broadcast(event));
    const run = () => this.runner.runTurn(handle.messages, text, events);
    return this.lock.withLock(run).finally(() => off());
  }

  approve(requestId: string, decision: ApprovalDecision): boolean {
    return this.approvals.resolve(requestId, decision);
  }

  dispose(id: string): Promise<void> {
    if (this.current !== undefined && this.current.id === id) this.current = undefined;
    return Promise.resolve();
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm test test/server/session.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/server/session.ts test/server/session.test.ts
git commit -m "feat(server): add single-session manager"
```

---

### 任务 6：HTTP 服务器（路由 + SSE 端点 + 静态文件）

**文件：**
- 创建：`src/server/http.ts`
- 测试：`test/server/http.test.ts`

`http.ts` 用 Node 内置 `node:http` 实现全部路由（`/api/*` + SSE `GET /api/events` + 静态文件）。为可测性，导出 `createWebServer(ctx)` 返回 `http.Server`，依赖通过 `WebContext` 注入。

- [ ] **步骤 1：编写失败的测试**

创建 `test/server/http.test.ts`：

```ts
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebServer, type WebContext } from "../../src/server/http.js";
import { SSEBroadcaster } from "../../src/server/bridge.js";
import { SessionManager, type TurnLock, type WebTurnRunner } from "../../src/server/session.js";
import { ApprovalCoordinator } from "../../src/server/approval.js";
import type { Server } from "node:http";

function makeContext(workdir: string): WebContext {
  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));
  const runner: WebTurnRunner = {
    newSession: () => [{ role: "system", content: "sys" }],
    runTurn: async (messages, text) => {
      messages.push({ role: "user", content: text });
      messages.push({ role: "assistant", content: `reply:${text}` });
    },
  };
  const lock: TurnLock = { withLock: async <T,>(fn: () => Promise<T>) => fn() };
  const session = new SessionManager(runner, lock, (event) => broadcaster.broadcast(event), approvals);
  return { session, broadcaster, workdir, staticDir: null };
}

async function listen(ctx: WebContext): Promise<{ server: Server; url: string }> {
  const server = createWebServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

let servers: Server[] = [];
let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "web-http-"));
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("http 路由", () => {
  it("GET /api/session 返回当前会话", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/session`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workdir).toBe(tmpDir);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("POST /api/message 返回 202 并写入会话", async () => {
    const ctx = makeContext(tmpDir);
    const { server, url } = await listen(ctx);
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = await (await fetch(`${url}/api/session`)).json();
    expect(s.messages.map((m: { content: string | null }) => m.content)).toContain("reply:hi");
  });

  it("POST /api/message 空文本返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/approval 非法 decision 返回 400", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "x", decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/approval 未知 id 返回 404", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "nope", decision: "allow" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/sessions 返回列表", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const res = await fetch(`${url}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it("GET /api/events 返回 SSE 头", async () => {
    const { server, url } = await listen(makeContext(tmpDir));
    servers.push(server);
    const parsed = new URL(url);
    await new Promise<void>((resolve, reject) => {
      http
        .get({ host: parsed.hostname, port: parsed.port, path: "/api/events" }, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.destroy();
          resolve();
        })
        .on("error", reject);
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
pnpm test test/server/http.test.ts
```

预期：FAIL，报错找不到 `../../src/server/http.js`。

- [ ] **步骤 3：实现 http.ts**

创建 `src/server/http.ts`：

```ts
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import type { SessionManager } from "./session.js";
import type { SSEBroadcaster } from "./bridge.js";
import type { ApprovalDecision } from "../security/approval.js";
import { SessionStore } from "../session/store.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export interface WebContext {
  session: SessionManager;
  broadcaster: SSEBroadcaster;
  workdir: string;
  /** 前端静态目录；dev 模式为 null（页面由 Vite dev server 提供）。 */
  staticDir: string | null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function listSessions(workdir: string): Array<{ file: string; mtime: number; preview: string }> {
  const dir = SessionStore.sessionsDir(workdir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const result: Array<{ file: string; mtime: number; preview: string }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      const messages = SessionStore.load(file);
      const firstUser = messages.find((m) => m.role === "user");
      result.push({
        file: name,
        mtime: statSync(file).mtimeMs,
        preview: (firstUser?.content ?? "").slice(0, 80),
      });
    } catch {
      // 跳过无法读取的文件
    }
  }
  result.sort((a, b) => b.mtime - a.mtime);
  return result;
}

function serveStatic(res: ServerResponse, root: string, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedRoot = path.resolve(root);
  const file = path.normalize(path.join(resolvedRoot, rel));
  if (!file.startsWith(resolvedRoot + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    json(res, 404, { error: "not found" });
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WebContext,
  method: string,
  pathname: string,
): Promise<void> {
  if (method === "GET" && pathname === "/api/session") {
    const handle = ctx.session.list()[0];
    if (handle === undefined) {
      json(res, 200, { sessionId: null, messages: [], workdir: ctx.workdir });
      return;
    }
    json(res, 200, { sessionId: handle.id, workdir: ctx.workdir, messages: handle.messages });
    return;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    json(res, 200, { sessions: listSessions(ctx.workdir) });
    return;
  }

  const sessionMatch = /^\/api\/sessions\/(.+)$/.exec(pathname);
  if (method === "GET" && sessionMatch !== null) {
    const file = decodeURIComponent(sessionMatch[1] ?? "");
    const messages = SessionStore.load(path.join(SessionStore.sessionsDir(ctx.workdir), file));
    json(res, 200, { file, messages });
    return;
  }

  if (method === "POST" && pathname === "/api/message") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") {
      json(res, 400, { error: "text is required" });
      return;
    }
    const handle = ctx.session.list()[0];
    if (handle === undefined) {
      json(res, 400, { error: "no active session" });
      return;
    }
    ctx.session.runTurn(handle.id, text).catch((error: unknown) => {
      ctx.broadcaster.broadcast({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    json(res, 202, { accepted: true });
    return;
  }

  if (method === "POST" && pathname === "/api/approval") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const decision = body.decision;
    if (decision !== "allow" && decision !== "deny" && decision !== "always_allow") {
      json(res, 400, { error: "invalid decision" });
      return;
    }
    const ok = ctx.session.approve(requestId, decision as ApprovalDecision);
    json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "unknown requestId" });
    return;
  }

  if (method === "POST" && pathname === "/api/session/new") {
    const handle = ctx.session.create(ctx.workdir);
    json(res, 200, { sessionId: handle.id });
    return;
  }

  if (method === "POST" && pathname === "/api/session/resume") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const file = typeof body.file === "string" ? body.file : "";
    if (file === "") {
      json(res, 400, { error: "file is required" });
      return;
    }
    const handle = ctx.session.resume(ctx.workdir, file);
    json(res, 200, { sessionId: handle.id });
    return;
  }

  json(res, 404, { error: "not found" });
}

export function createWebServer(ctx: WebContext): Server {
  return createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/api/events") {
        const off = ctx.broadcaster.subscribe(res);
        res.on("close", off);
        return;
      }
      if (pathname.startsWith("/api/")) {
        await handleApi(req, res, ctx, method, pathname);
        return;
      }
      if (ctx.staticDir === null) {
        json(res, 404, { error: "not found (dev mode: use Vite dev server)" });
        return;
      }
      serveStatic(res, ctx.staticDir, pathname);
    })().catch((error: unknown) => {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```bash
pnpm test test/server/http.test.ts
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/server/http.ts test/server/http.test.ts
git commit -m "feat(server): add node:http server with routes, SSE and static files"
```

---

### 任务 7：web 启动入口 + `blh web` 命令（harness.ts + index.ts + main.ts）

**文件：**
- 创建：`src/cli/harness.ts`（把 `buildHarness` 从 main.ts 抽出来）
- 创建：`src/server/index.ts`
- 修改：`src/cli/main.ts`（import/re-export `buildHarness`、新增 web 命令分支、`parseCliArgs` 支持 `web`/`port`/`dev`、`USAGE` 补 web 说明）
- 测试：修改 `test/cli/main.test.ts`（`parseCliArgs` 的 web/port/dev 用例）

把 `buildHarness` 抽到独立文件，是为了避免「`cli/main.ts` 引入 `server/index.ts`、`server/index.ts` 又引入 `cli/main.ts` 的 `buildHarness`」形成循环导入。抽出后依赖链为 `main.ts → server/index.ts → cli/harness.ts`（无环）。

- [ ] **步骤 1：创建 harness.ts（迁移 buildHarness）**

创建 `src/cli/harness.ts`（内容 = main.ts 里任务 2 泛化后的 `buildHarness`，连同它用到的 import 一起搬来）：

```ts
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
import { initLogger } from "../core/logger.js";

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
```

- [ ] **步骤 2：改写 main.ts 的 import 区并移除原 buildHarness**

把 `src/cli/main.ts` 顶部 import 块整体替换为（移除已迁走的 import，保留 REPL/入口所需，新增 `exec`、`startWebServer`、`buildHarness` 导入与 re-export）：

```ts
import { exec } from "node:child_process";
import readline from "node:readline";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { lastAssistantText } from "../core/loop.js";
import { repl, makeReadlineIO } from "./repl.js";
import type { ChatMessage } from "../core/types.js";
import { SessionStore } from "../session/store.js";
import { createLogger } from "../core/logger.js";
import type { ApprovalAsker, ApprovalDecision } from "../security/approval.js";
import { startWebServer } from "../server/index.js";
import { buildHarness } from "./harness.js";

export { buildHarness };

export const log = createLogger("cli");
```

同时删除 main.ts 里原本的 `buildHarness` 函数定义（连同随它一起迁走的 import；`log`、`USAGE`、`parseCliArgs`、`makeAskUser`、`main`、`isDirectRun` 保留）。

- [ ] **步骤 3：扩展 parseCliArgs 支持 web / port / dev**

把 `ParsedCliArgs` 接口改为：

```ts
export interface ParsedCliArgs {
  prompt?: string;
  workdir?: string;
  help?: boolean;
  skipPermissions?: boolean;
  continue?: boolean;
  continueFile?: string;
  web?: boolean;
  port?: number;
  dev?: boolean;
  cli: Record<string, string>;
}
```

把 `parseCliArgs` 里 `const { values } = parseArgs({...})` 改为解构出 `positionals`，options 增加 `port` / `dev`：

```ts
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      print: { type: "string", short: "p" },
      model: { type: "string" },
      "base-url": { type: "string" },
      workdir: { type: "string" },
      "bash-timeout": { type: "string" },
      "max-output-chars": { type: "string" },
      "dangerously-skip-permissions": { type: "boolean" },
      port: { type: "string" },
      dev: { type: "boolean" },
    },
    strict: false,
  });
```

在原有解析（`model`/`baseUrl`/`bashTimeout`/`maxOutputChars`/`workdirValue`/`prompt`/`help`/`skipPermissions`）之后追加：

```ts
  const web = positionals[0] === "web";
  const portValue = stringValue(values, "port");
  const port =
    portValue !== undefined && /^\d+$/.test(portValue) ? Number.parseInt(portValue, 10) : undefined;
  const dev = values.dev === true;
```

并在 return 对象里追加：

```ts
    ...(web ? { web: true } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(dev ? { dev: true } : {}),
```

- [ ] **步骤 4：main() 增加 web 分支与 openBrowser 辅助**

在 `main()` 开头解构里加 `web, port, dev`：

```ts
  const { prompt, workdir, cli, help, skipPermissions, continue: doContinue, continueFile, web, port, dev } =
    parseCliArgs(process.argv.slice(2));
```

在 `if (help) { ... }` 之后、`if (prompt !== undefined)` 之前插入：

```ts
  if (web) {
    const server = await startWebServer({ workdir, cli, port, dev, skipPermissions });
    log.info("web 服务器已启动", { url: server.url });
    openBrowser(server.url);
    return;
  }
```

在 `makeAskUser` 之后新增 `openBrowser` 辅助函数：

```ts
function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}
```

- [ ] **步骤 5：更新 USAGE**

在 `USAGE` 模板字符串里 `-h, --help` 行之前追加：

```
  blh web [--port N] [--dev] [--workdir 目录]
                          启动 web 交互式工作台（默认 http://127.0.0.1:8123）
```

- [ ] **步骤 6：实现 server/index.ts**

创建 `src/server/index.ts`：

```ts
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { buildHarness } from "../cli/harness.js";
import { createWebServer } from "./http.js";
import { SSEBroadcaster } from "./bridge.js";
import { ApprovalCoordinator, loadUserRules, persistUserRule } from "./approval.js";
import { SessionManager } from "./session.js";

export interface WebServerOptions {
  workdir?: string;
  cli?: Record<string, unknown>;
  port?: number;
  dev?: boolean;
  skipPermissions?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function staticDir(dev: boolean): string | null {
  if (dev) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server/index.js → ../../web = dist/web
  return path.resolve(here, "..", "web");
}

export async function startWebServer(options: WebServerOptions): Promise<RunningWebServer> {
  // 先解析一次 workdir，用于在 buildHarness 之前加载用户规则
  const config = loadConfig(options.workdir, options.cli);
  const workdir = config.workdir;

  const broadcaster = new SSEBroadcaster();
  const approvals = new ApprovalCoordinator((event) => broadcaster.broadcast(event));

  const userRules = loadUserRules(workdir);
  const harness = buildHarness(
    options.workdir,
    options.cli,
    (req) => approvals.ask(req),
    options.skipPermissions ?? false,
    {
      userRules,
      persistRule: (rule) => persistUserRule(workdir, rule),
    },
  );

  const session = new SessionManager(
    harness,
    harness.jobs!.agentLock,
    (event) => broadcaster.broadcast(event),
    approvals,
  );
  session.create(workdir);

  const server = createWebServer({
    session,
    broadcaster,
    workdir,
    staticDir: staticDir(options.dev ?? false),
  });

  const port = options.port !== undefined && Number.isInteger(options.port) ? options.port : 8123;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
```

说明：`loadConfig` 在这里与 `buildHarness` 内部各调用一次（幂等、只读文件），代价可忽略，换来「先拿到 workdir 再加载用户规则」的简单性。

- [ ] **步骤 7：补充 parseCliArgs 的 web 测试**

在 `test/cli/main.test.ts` 的 `parseCliArgs` describe 末尾追加：

```ts
  it("解析 web 子命令与 --port/--dev", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["web", "--port", "9000", "--dev"]);
    expect(parsed.web).toBe(true);
    expect(parsed.port).toBe(9000);
    expect(parsed.dev).toBe(true);
  });

  it("无 web 子命令时不带 web/port/dev 标记", async () => {
    const { parseCliArgs } = await import("../../src/cli/main.js");
    const parsed = parseCliArgs(["-p", "hi"]);
    expect(parsed.web).toBeUndefined();
    expect(parsed.port).toBeUndefined();
    expect(parsed.dev).toBeUndefined();
  });
```

- [ ] **步骤 8：运行类型检查与测试**

运行：

```bash
pnpm typecheck
pnpm test test/cli/main.test.ts
```

预期：typecheck 通过；`parseCliArgs` 新旧用例全 PASS（`buildHarness` re-export 后 `main.test.ts` 的 `import("../../src/cli/main.js")` 仍能取到 `buildHarness`）。

- [ ] **步骤 9：手动冒烟（可选）**

运行：

```bash
pnpm dev web --dev
```

预期：打印 `web 服务器已启动 http://127.0.0.1:8123`（缺 `OPENAI_API_KEY` 时会先报错退出，属预期）；`Ctrl+C` 停止。

- [ ] **步骤 10：Commit**

```bash
git add src/cli/harness.ts src/cli/main.ts src/server/index.ts test/cli/main.test.ts
git commit -m "feat(server): add blh web command and startWebServer entry"
```

---

### 任务 8：共享客户端 `@blh/web-client`（类型 + SSE + fetch 封装）

**文件：**
- 创建：`packages/web-client/src/types.ts`
- 创建：`packages/web-client/src/sse.ts`
- 创建：`packages/web-client/src/api.ts`
- 创建：`packages/web-client/src/index.ts`

这是纯源码包（无构建步骤，由 Vite 直接消费 TS 源码）。它是根包 `src/server` 里 `WebEvent`/`AgentEvent` 的**镜像类型**（根包不依赖前端包，二者结构一致、需人工保持一致）。浏览器端无单测运行器，本任务用 `typecheck` 验证，真正的集成行为由任务 13 的 Playwright e2e 覆盖。

- [ ] **步骤 1：创建 types.ts**

创建 `packages/web-client/src/types.ts`：

```ts
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "assistant_text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "turn_end" };

export type WebEvent =
  | AgentEvent
  | {
      type: "approval_requested";
      requestId: string;
      tool: string;
      target: string;
      args: Record<string, unknown>;
    }
  | { type: "error"; message: string };

export type ApprovalDecision = "allow" | "deny" | "always_allow";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

export interface SessionInfo {
  sessionId: string | null;
  workdir: string;
  messages: ChatMessage[];
}

export interface SessionListItem {
  file: string;
  mtime: number;
  preview: string;
}
```

- [ ] **步骤 2：创建 sse.ts**

创建 `packages/web-client/src/sse.ts`：

```ts
import type { WebEvent } from "./types.js";

const EVENT_TYPES = [
  "turn_start",
  "assistant_text_delta",
  "tool_call",
  "tool_result",
  "turn_end",
  "approval_requested",
  "error",
] as const;

/** 订阅 SSE 事件流，返回取消订阅函数（会关闭 EventSource）。 */
export function connectEvents(url: string, onEvent: (event: WebEvent) => void): () => void {
  const es = new EventSource(url);
  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as Record<string, unknown>;
        onEvent({ type, ...data } as WebEvent);
      } catch {
        onEvent({ type: "error", message: `bad SSE payload for ${type}` });
      }
    });
  }
  return () => es.close();
}
```

- [ ] **步骤 3：创建 api.ts**

创建 `packages/web-client/src/api.ts`：

```ts
import type { ApprovalDecision, ChatMessage, SessionInfo, SessionListItem } from "./types.js";

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getSession(): Promise<SessionInfo> {
  return request<SessionInfo>("/api/session");
}

export async function listSessions(): Promise<SessionListItem[]> {
  return (await request<{ sessions: SessionListItem[] }>("/api/sessions")).sessions;
}

export async function getSessionMessages(file: string): Promise<ChatMessage[]> {
  return (await request<{ messages: ChatMessage[] }>(`/api/sessions/${encodeURIComponent(file)}`)).messages;
}

export function sendMessage(text: string): Promise<unknown> {
  return request("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function respondApproval(requestId: string, decision: ApprovalDecision): Promise<unknown> {
  return request("/api/approval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, decision }),
  });
}

export async function newSession(): Promise<string> {
  return (await request<{ sessionId: string }>("/api/session/new", { method: "POST" })).sessionId;
}

export async function resumeSession(file: string): Promise<string> {
  return (
    await request<{ sessionId: string }>("/api/session/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
    })
  ).sessionId;
}
```

- [ ] **步骤 4：创建 index.ts**

创建 `packages/web-client/src/index.ts`：

```ts
export * from "./types.js";
export { connectEvents } from "./sse.js";
export * from "./api.js";
```

- [ ] **步骤 5：类型检查**

运行：

```bash
pnpm --filter @blh/web-client typecheck
```

预期：通过（无报错）。

- [ ] **步骤 6：Commit**

```bash
git add packages/web-client
git commit -m "feat(web-client): add shared SSE/HTTP client types and wrappers"
```

---

### 任务 9：`useAgentEvents` 状态 hook

**文件：**
- 创建：`apps/web/src/hooks/useAgentEvents.ts`

这是前端唯一的状态源：挂载时从 `GET /api/session` 载入历史、订阅 `/api/events` 的 SSE 流，把 agent 事件映射成 UI 状态（消息列表、流式文本、工具卡片、待审批请求）。浏览器端无单测运行器，本任务用 `typecheck` 验证，集成行为由任务 13 的 Playwright 覆盖。

- [ ] **步骤 1：创建 hook**

创建 `apps/web/src/hooks/useAgentEvents.ts`：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  connectEvents,
  getSession,
  listSessions,
  newSession,
  respondApproval,
  resumeSession,
  sendMessage,
  type ApprovalDecision,
  type ChatMessage,
  type SessionListItem,
} from "@blh/web-client";

/** 一次工具调用在前端展示所需的状态（参数 + 结果）。 */
export interface ToolEvent {
  id: string;
  name: string;
  arguments: string;
  output?: string;
  isError?: boolean;
}

/** 待用户处理的审批请求（对应 approval_requested 事件去掉 type）。 */
export interface ApprovalRequest {
  requestId: string;
  tool: string;
  target: string;
  args: Record<string, unknown>;
}

export interface AgentState {
  messages: ChatMessage[];
  toolEvents: ToolEvent[];
  streaming: string;
  approval: ApprovalRequest | null;
  error: string | null;
  busy: boolean;
  sessions: SessionListItem[];
  sessionId: string | null;
  workdir: string;
  send(text: string): Promise<void>;
  respond(decision: ApprovalDecision): Promise<void>;
  createSession(): Promise<void>;
  resume(file: string): Promise<void>;
}

export function useAgentEvents(): AgentState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [streaming, setStreaming] = useState("");
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [workdir, setWorkdir] = useState("");

  /** 从服务器取回权威消息与工作目录，并刷新会话列表。 */
  const refresh = useCallback(async () => {
    const info = await getSession();
    setSessionId(info.sessionId);
    setWorkdir(info.workdir);
    setMessages(info.messages);
    void listSessions().then(setSessions);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const off = connectEvents("/api/events", (event) => {
      switch (event.type) {
        case "turn_start":
          setBusy(true);
          setStreaming("");
          setToolEvents([]);
          break;
        case "assistant_text_delta":
          setStreaming((s) => s + event.text);
          break;
        case "tool_call":
          setToolEvents((ts) => [
            ...ts,
            { id: event.id, name: event.name, arguments: event.arguments },
          ]);
          break;
        case "tool_result":
          setToolEvents((ts) =>
            ts.map((t) =>
              t.id === event.id ? { ...t, output: event.output, isError: event.isError } : t,
            ),
          );
          break;
        case "turn_end":
          setBusy(false);
          setStreaming("");
          setToolEvents([]);
          void refresh();
          break;
        case "approval_requested":
          setApproval({
            requestId: event.requestId,
            tool: event.tool,
            target: event.target,
            args: event.args,
          });
          break;
        case "error":
          setError(event.message);
          break;
      }
    });
    return off;
  }, [refresh]);

  const send = useCallback(async (text: string) => {
    const userMessage: ChatMessage = { role: "user", content: text };
    setMessages((ms) => [...ms, userMessage]);
    setError(null);
    await sendMessage(text);
  }, []);

  const respond = useCallback(
    async (decision: ApprovalDecision) => {
      if (approval === null) return;
      const id = approval.requestId;
      setApproval(null);
      await respondApproval(id, decision);
    },
    [approval],
  );

  const createSession = useCallback(async () => {
    await newSession();
    await refresh();
  }, [refresh]);

  const resume = useCallback(
    async (file: string) => {
      await resumeSession(file);
      await refresh();
    },
    [refresh],
  );

  return {
    messages,
    toolEvents,
    streaming,
    approval,
    error,
    busy,
    sessions,
    sessionId,
    workdir,
    send,
    respond,
    createSession,
    resume,
  };
}
```

- [ ] **步骤 2：类型检查**

运行：

```bash
pnpm --filter @blh/web typecheck
```

预期：通过（此时 `App.tsx`、`main.tsx` 尚未创建，`src/` 下只有本 hook 与 `vite-env.d.ts`）。

- [ ] **步骤 3：Commit**

```bash
git add apps/web/src/hooks/useAgentEvents.ts
git commit -m "feat(web): add useAgentEvents hook bridging SSE to UI state"
```

---

### 任务 10：UI 组件（聊天面板、工具卡片、输入栏、审批弹窗、会话侧栏）

**文件：**
- 创建：`apps/web/src/components/ToolCallCard.tsx`
- 创建：`apps/web/src/components/ChatPanel.tsx`
- 创建：`apps/web/src/components/InputBar.tsx`
- 创建：`apps/web/src/components/ApprovalModal.tsx`
- 创建：`apps/web/src/components/SessionSidebar.tsx`

五个纯展示/受控组件，全部通过 props 接收状态与回调，不直接依赖 hook。样式 class 在任务 11 的 `styles.css` 里定义。

- [ ] **步骤 1：创建 ToolCallCard**

创建 `apps/web/src/components/ToolCallCard.tsx`：

```tsx
import type { ToolEvent } from "../hooks/useAgentEvents";

export function ToolCallCard({ event }: { event: ToolEvent }) {
  const running = event.output === undefined;
  return (
    <div className={`tool-card${event.isError === true ? " tool-card-error" : ""}`}>
      <div className="tool-card-head">
        <strong>{event.name}</strong>
        <span>{running ? "执行中…" : event.isError === true ? "失败" : "完成"}</span>
      </div>
      <pre className="tool-card-args">{event.arguments}</pre>
      {event.output !== undefined && <pre className="tool-card-output">{event.output}</pre>}
    </div>
  );
}
```

- [ ] **步骤 2：创建 ChatPanel**

创建 `apps/web/src/components/ChatPanel.tsx`：

```tsx
import type { ChatMessage } from "@blh/web-client";
import type { ToolEvent } from "../hooks/useAgentEvents";
import { ToolCallCard } from "./ToolCallCard";

export function ChatPanel(props: {
  messages: ChatMessage[];
  streaming: string;
  toolEvents: ToolEvent[];
  busy: boolean;
}) {
  const { messages, streaming, toolEvents, busy } = props;
  return (
    <div className="chat-panel">
      {messages
        .filter((m) => m.role !== "system")
        .map((m, i) => (
          <div key={i} className={`bubble bubble-${m.role}`}>
            <span className="bubble-role">{m.role}</span>
            <span className="bubble-text">{m.content ?? ""}</span>
          </div>
        ))}
      {toolEvents.map((t) => (
        <ToolCallCard key={t.id} event={t} />
      ))}
      {(busy || streaming !== "") && (
        <div className="bubble bubble-assistant">
          <span className="bubble-role">assistant</span>
          <span className="bubble-text">{streaming !== "" ? streaming : "…"}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **步骤 3：创建 InputBar**

创建 `apps/web/src/components/InputBar.tsx`：

```tsx
import { useState } from "react";

export function InputBar(props: { busy: boolean; onSend(text: string): void }) {
  const { busy, onSend } = props;
  const [text, setText] = useState("");

  function submit() {
    const t = text.trim();
    if (t === "") return;
    setText("");
    onSend(t);
  }

  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入消息…"
        disabled={busy}
      />
      <button type="submit" disabled={busy || text.trim() === ""}>
        发送
      </button>
    </form>
  );
}
```

- [ ] **步骤 4：创建 ApprovalModal**

创建 `apps/web/src/components/ApprovalModal.tsx`：

```tsx
import type { ApprovalDecision } from "@blh/web-client";
import type { ApprovalRequest } from "../hooks/useAgentEvents";

export function ApprovalModal(props: {
  approval: ApprovalRequest | null;
  onRespond(decision: ApprovalDecision): void;
}) {
  const { approval, onRespond } = props;
  if (approval === null) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>工具需要授权</h2>
        <p>
          <strong>{approval.tool}</strong>
          {approval.target !== "" ? `：${approval.target}` : ""}
        </p>
        <pre className="modal-args">{JSON.stringify(approval.args, null, 2)}</pre>
        <div className="modal-actions">
          <button onClick={() => onRespond("deny")}>拒绝</button>
          <button onClick={() => onRespond("allow")}>允许</button>
          <button onClick={() => onRespond("always_allow")}>总是允许</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **步骤 5：创建 SessionSidebar**

创建 `apps/web/src/components/SessionSidebar.tsx`：

```tsx
import type { SessionListItem } from "@blh/web-client";

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  onNew(): void;
  onResume(file: string): void;
}) {
  const { sessions, activeId, onNew, onResume } = props;
  return (
    <aside className="sidebar">
      <button className="sidebar-new" onClick={onNew}>
        新建会话
      </button>
      <ul className="sidebar-list">
        {sessions.map((s) => (
          <li key={s.file}>
            <button
              className={`sidebar-item${s.file === activeId ? " sidebar-item-active" : ""}`}
              onClick={() => onResume(s.file)}
            >
              {s.preview !== "" ? s.preview : s.file}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **步骤 6：类型检查**

运行：

```bash
pnpm --filter @blh/web typecheck
```

预期：通过。

- [ ] **步骤 7：Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): add chat, tool, input, approval and sidebar components"
```

---

### 任务 11：App 组装 + 入口 + 全局样式

**文件：**
- 创建：`apps/web/src/App.tsx`
- 创建：`apps/web/src/main.tsx`
- 创建：`apps/web/src/styles.css`

把 hook 与组件组装成完整页面，用 `vite build` 冒烟验证前端可打包。

- [ ] **步骤 1：创建 App.tsx**

创建 `apps/web/src/App.tsx`：

```tsx
import { useAgentEvents } from "./hooks/useAgentEvents";
import { ChatPanel } from "./components/ChatPanel";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { SessionSidebar } from "./components/SessionSidebar";

export function App() {
  const state = useAgentEvents();

  return (
    <div className="app">
      <header className="topbar">
        <h1>blh 工作台</h1>
        <span className="workdir">{state.workdir}</span>
      </header>
      <div className="body">
        <SessionSidebar
          sessions={state.sessions}
          activeId={state.sessionId}
          onNew={() => void state.createSession()}
          onResume={(file) => void state.resume(file)}
        />
        <main className="main">
          <ChatPanel
            messages={state.messages}
            streaming={state.streaming}
            toolEvents={state.toolEvents}
            busy={state.busy}
          />
          {state.error !== null && <div className="error-banner">{state.error}</div>}
          <InputBar busy={state.busy} onSend={(text) => void state.send(text)} />
        </main>
      </div>
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
```

- [ ] **步骤 2：创建 main.tsx**

创建 `apps/web/src/main.tsx`：

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
```

- [ ] **步骤 3：创建 styles.css**

创建 `apps/web/src/styles.css`：

```css
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.app { display: flex; flex-direction: column; height: 100%; }

.topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #ddd; }
.topbar h1 { font-size: 16px; margin: 0; }
.workdir { color: #888; font-size: 12px; }

.body { display: flex; flex: 1; min-height: 0; }

.sidebar { width: 220px; border-right: 1px solid #ddd; padding: 8px; overflow-y: auto; }
.sidebar-new { width: 100%; padding: 6px; margin-bottom: 8px; }
.sidebar-list { list-style: none; margin: 0; padding: 0; }
.sidebar-item { width: 100%; text-align: left; padding: 6px 8px; border: none; background: none; cursor: pointer; }
.sidebar-item:hover { background: #f0f0f0; }
.sidebar-item-active { background: #e0e8ff; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.chat-panel { flex: 1; overflow-y: auto; padding: 16px; }
.bubble { margin-bottom: 10px; display: flex; flex-direction: column; max-width: 80%; }
.bubble-user { align-items: flex-end; margin-left: auto; }
.bubble-assistant { align-items: flex-start; }
.bubble-tool { align-items: flex-start; }
.bubble-role { font-size: 11px; color: #999; margin-bottom: 2px; }
.bubble-text { padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.bubble-user .bubble-text { background: #e8f0fe; }
.bubble-assistant .bubble-text { background: #f1f3f4; }
.bubble-tool .bubble-text { background: #fef7e0; font-family: monospace; font-size: 12px; }

.tool-card { border: 1px solid #ddd; border-radius: 6px; padding: 8px; margin-bottom: 10px; background: #fafafa; }
.tool-card-error { border-color: #e74c3c; background: #fdf0ee; }
.tool-card-head { display: flex; justify-content: space-between; margin-bottom: 4px; }
.tool-card-args, .tool-card-output { margin: 4px 0 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; }

.error-banner { padding: 8px 16px; background: #fdf0ee; color: #c0392b; border-top: 1px solid #e74c3c; }

.input-bar { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #ddd; }
.input-bar input { flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
.input-bar button { padding: 8px 16px; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; }
.modal { background: #fff; border-radius: 8px; padding: 20px; width: 480px; max-width: 90vw; }
.modal-args { background: #f5f5f5; padding: 8px; border-radius: 4px; font-size: 12px; overflow: auto; max-height: 200px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.modal-actions button { padding: 6px 14px; }
```

- [ ] **步骤 4：类型检查 + 构建冒烟**

运行：

```bash
pnpm --filter @blh/web typecheck
pnpm --filter @blh/web build
```

预期：typecheck 通过；`vite build` 产出 `dist/web/index.html`（根目录 `dist/web/`）。

- [ ] **步骤 5：Commit**

```bash
git add apps/web/src
git commit -m "feat(web): assemble App entry and global styles"
```

---

### 任务 12：根包 `build:web` 脚本

**文件：**
- 修改：`package.json`

把前端构建纳入根包脚本，让 `pnpm build:web` 一键产出 `dist/web/`（与 `pnpm build` 产出的 `dist/server/` 同目录，供生产模式 `blh web` 提供静态文件）。

- [ ] **步骤 1：新增脚本**

在根 `package.json` 的 `scripts` 里，`"build"` 之后插入一行：

```json
    "build": "tsc -p tsconfig.build.json",
    "build:web": "pnpm --filter @blh/web build",
    "typecheck": "tsc --noEmit",
```

（完整生产构建顺序为 `pnpm build && pnpm build:web`。）

- [ ] **步骤 2：验证脚本**

运行：

```bash
pnpm build:web
```

预期：成功，`dist/web/index.html` 存在。

- [ ] **步骤 3：Commit**

```bash
git add package.json
git commit -m "chore: add build:web script"
```

---

### 任务 13：Playwright e2e

**文件：**
- 修改：`apps/web/package.json`（新增 `@playwright/test` 与 `test:e2e` 脚本）
- 创建：`apps/web/playwright.config.ts`
- 创建：`apps/web/e2e/mock-server.mjs`
- 创建：`apps/web/e2e/workbench.spec.ts`

e2e 用 Playwright 的 `webServer` 同时拉起 Vite dev server（5173，代理 `/api` 到 8123）和一个独立 mock 后端（8123，实现 `/api/*` 与 SSE，无需 `OPENAI_API_KEY`），验证真实浏览器里前端渲染 + SSE 流式回复。

- [ ] **步骤 1：更新 apps/web 的 package.json**

把 `apps/web/package.json` 的 `scripts` 加一行、`devDependencies` 加一项：

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "preview": "vite preview",
    "test:e2e": "playwright test"
  },
```

```json
  "devDependencies": {
    "@playwright/test": "^1.48.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^6.0.0"
  }
```

- [ ] **步骤 2：创建 mock-server.mjs**

创建 `apps/web/e2e/mock-server.mjs`（有状态：记录消息并在 `/api/session` 回读，供前端 `turn_end` 后 `refresh()` 使用）：

```js
import http from "node:http";

const clients = new Set();
const messages = [];

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

function frame(type, data = {}) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(type, data) {
  const f = frame(type, data);
  for (const c of clients) c.write(f);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const { pathname } = url;
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/events") {
    sse(res);
    return;
  }
  if (method === "GET" && pathname === "/api/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: "test", workdir: "/tmp", messages }));
    return;
  }
  if (method === "GET" && pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: [] }));
    return;
  }
  if (method === "POST" && pathname === "/api/message") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const text = (JSON.parse(body || "{}").text ?? "").toString();
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      messages.push({ role: "user", content: text });
      broadcast("turn_start");
      broadcast("assistant_text_delta", { text: "你好，世界" });
      messages.push({ role: "assistant", content: "你好，世界" });
      broadcast("turn_end");
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(8123, "127.0.0.1");
```

- [ ] **步骤 3：创建 playwright.config.ts**

创建 `apps/web/playwright.config.ts`：

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5173",
  },
  webServer: [
    {
      command: "pnpm --filter @blh/web dev",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: true,
    },
    {
      command: "node e2e/mock-server.mjs",
      url: "http://127.0.0.1:8123/api/session",
      reuseExistingServer: true,
    },
  ],
});
```

- [ ] **步骤 4：创建 e2e 用例**

创建 `apps/web/e2e/workbench.spec.ts`：

```ts
import { test, expect } from "@playwright/test";

test("工作台加载并显示标题", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "blh 工作台" })).toBeVisible();
});

test("发送消息后展示流式回复", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("你好");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("你好，世界")).toBeVisible();
});
```

- [ ] **步骤 5：安装依赖并安装浏览器**

运行：

```bash
pnpm install
pnpm --filter @blh/web exec playwright install chromium
```

预期：`@playwright/test` 解析成功；chromium 下载完成。

- [ ] **步骤 6：运行 e2e**

运行：

```bash
pnpm --filter @blh/web test:e2e
```

预期：2 个用例 PASS（Playwright 自动拉起 Vite + mock 后端，跑完自动关闭）。

- [ ] **步骤 7：全量回归**

运行：

```bash
pnpm typecheck
pnpm test
```

预期：根包 typecheck 与全部单测仍 PASS（前端改动不影响根包）。

- [ ] **步骤 8：Commit**

```bash
git add apps/web/package.json apps/web/playwright.config.ts apps/web/e2e pnpm-lock.yaml
git commit -m "test(web): add Playwright e2e for workbench"
```

---

## 自检

- **规格覆盖度：** 目标（`blh web` 命令）、架构（`src/server/` + SSE + React 前端 + 共享客户端）、技术栈（node:http / React 18 / Vite / TypeScript NodeNext / vitest / Playwright）均在任务 1–13 中有对应实现。
- **类型一致性：** `WebEvent`/`AgentEvent` 的字段在 `src/server/bridge.ts`（任务 3）与 `packages/web-client/src/types.ts`（任务 8）保持一致；`ApprovalDecision` 在 `src/security/approval.ts`（任务 2）、`src/server/approval.ts`（任务 4）、`packages/web-client`（任务 8）一致；`SessionHandle.id` 用文件 basename，与前端 `SessionListItem.file`（任务 6/8）对齐。
- **无占位符：** 所有代码步骤均含完整实现与精确命令。

