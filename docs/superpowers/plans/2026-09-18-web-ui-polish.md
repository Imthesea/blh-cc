# 前端界面优化（对齐 deepseek-harness）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `apps/web` 前端界面重做，视觉与布局对齐参考项目 `F:\allProject\githubProject\deepseek-harness` 的 sidebar 设计语言，并新增左上角 logo、logo 旁折叠、会话列表悬停三点删除三个能力。

**架构：** 当前前端是「单文件全局 CSS + 少量 React 组件」结构。保持该结构不变（不引入 CSS Modules / Tailwind / 组件库），把 deepseek-harness 的 `--dsw-*` 设计 token（浅色主题）和 sidebar 布局规则以 CSS 变量 + 全局类名的方式落地到 `styles.css`，组件据此重写类名与结构。删除会话需要打通「存储层 → web-server → web-client → 前端 hook → UI」的完整链路。

**技术栈：** React 18 + Vite + 原生 CSS（无 UI 库）、Node http 自研 web-server、vitest（后端单测）、Playwright（e2e）。

**关键设计参数（直接取自 deepseek-harness，勿改）：**
- sidebar 展开宽度 280px，折叠 rail 56px
- 缓动 `cubic-bezier(0.4, 0, 0.2, 1)`，时长 fast 0.1s / normal 0.2s / slow 0.3s
- logo 行高 60px（展开）/ 36px（折叠），品牌字 18px/600
- 新建按钮 38px 高、12px 圆角
- 会话行 32px 高、8px 圆角、padding 0 8px
- 三点菜单卡片 218px 宽、12px 圆角、阴影 `--dsw-shadow-lv3`
- 品牌色 = 近黑 `rgb(15, 17, 21)`，sidebar 填充 `rgb(249, 250, 251)`

---

## 文件改动总览

**后端（删除会话）：**
- 修改 `src/session/store.ts`：新增 `SessionStore.remove(filePath)`
- 修改 `apps/web-server/src/types.ts`：`SessionStoreModule` 增加 `remove`
- 修改 `apps/web-server/src/session.ts`：`SessionManager` 增加 `remove(workdir, file)`
- 修改 `apps/web-server/src/http.ts`：新增 `POST /api/session/delete`
- 修改 `packages/web-client/src/api.ts`：新增 `deleteSession(file)`
- 测试：`test/session/store.test.ts`、`apps/web-server/test/helpers.ts`、`apps/web-server/test/session.test.ts`、`apps/web-server/test/http.test.ts`

**前端（样式 + UI）：**
- 重写 `apps/web/src/styles.css`：注入设计 token + 布局 + 组件样式
- 创建 `apps/web/src/components/Logo.tsx`：blh 品牌标识（SVG + 字标）
- 创建 `apps/web/src/components/icons.tsx`：三点 / 折叠 / 新建 / 删除等内联 SVG 图标
- 修改 `apps/web/src/App.tsx`：移除顶部 topbar，改为「sidebar + main」两栏布局，持有折叠状态
- 修改 `apps/web/src/hooks/useAgentEvents.ts`：新增 `deleteSession(file)`
- 重写 `apps/web/src/components/SessionSidebar.tsx`：logo 行 + 折叠 + 新建 + 会话列表（三点删除）
- 修改 `apps/web/src/components/ChatPanel.tsx` / `InputBar.tsx` / `ToolCallCard.tsx` / `ApprovalModal.tsx`：类名对齐新设计
- 修改 `apps/web/index.html`：`<title>` 改为 `blh`
- e2e：`apps/web/e2e/mock-server.mjs`、`apps/web/e2e/workbench.spec.ts`

---

## 任务 1：后端删除会话能力（TDD）

### 任务 1.1 存储层 `SessionStore.remove`

**文件：**
- 修改：`src/session/store.ts`（import 行 + 新增静态方法）
- 测试：`test/session/store.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `test/session/store.test.ts` 的 `describe("SessionStore")` 内、`open 返回指向给定路径的实例` 用例之后追加：

```ts
it("remove 删除指定会话文件，文件不存在时静默", () => {
  const store = SessionStore.create(tmpDir);
  expect(existsSync(store.path)).toBe(true);
  SessionStore.remove(store.path);
  expect(existsSync(store.path)).toBe(false);
  // 再次删除不抛错
  expect(() => SessionStore.remove(store.path)).not.toThrow();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/session/store.test.ts`

预期：FAIL，报错 `SessionStore.remove is not a function`（或 TS 编译报错 `Property 'remove' does not exist`）。

- [ ] **步骤 3：实现 `remove`**

修改 `src/session/store.ts` 顶部 import：

```ts
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
```

在 `static load(filePath: string)` 方法之前插入：

```ts
  /** 删除指定会话文件；文件不存在时静默（幂等）。 */
  static remove(filePath: string): void {
    rmSync(filePath, { force: true });
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/session/store.test.ts`

预期：PASS（含新增用例）。

- [ ] **步骤 5：Commit**

```bash
git add src/session/store.ts test/session/store.test.ts
git commit -m "feat(session): add SessionStore.remove"
```

### 任务 1.2 接口与测试存储对齐

**文件：**
- 修改：`apps/web-server/src/types.ts`
- 修改：`apps/web-server/test/helpers.ts`

- [ ] **步骤 1：在 `SessionStoreModule` 接口补 `remove` 与 `latest`**

修改 `apps/web-server/src/types.ts`，在 `SessionStoreModule` 的 `load` 之后加：

```ts
  remove(filePath: string): void;
  latest(workdir: string): string | null;
```

- [ ] **步骤 2：测试存储实现 `remove` 与 `latest`**

修改 `apps/web-server/test/helpers.ts`：

顶部 import 增加 `readdirSync`、`rmSync`、`statSync`：

```ts
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
```

在 `makeTestSessionStore()` 返回对象的 `load(filePath) {...}` 之后加：

```ts
    remove(filePath) {
      rmSync(filePath, { force: true });
    },
    latest(workdir) {
      const dir = sessionsDir(workdir);
      let latestPath: string | null = null;
      let latestMtime = 0;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const p = path.join(dir, name);
        const mtime = statSync(p).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestPath = p;
        }
      }
      return latestPath;
    },
```

- [ ] **步骤 3：typecheck 验证**

运行：`pnpm --filter @blh/web-server typecheck`

预期：通过（无类型错误）。

- [ ] **步骤 4：Commit**

```bash
git add apps/web-server/src/types.ts apps/web-server/test/helpers.ts
git commit -m "feat(web-server): extend SessionStoreModule with remove"
```

### 任务 1.3 `SessionManager.remove`

**文件：**
- 修改：`apps/web-server/src/session.ts`
- 测试：`apps/web-server/test/session.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `apps/web-server/test/session.test.ts` 的 `describe("SessionManager")` 内、`dispose 清空当前会话` 用例之后追加：

```ts
it("remove 删除当前会话后跳到剩余最新会话", () => {
  const manager = new SessionManager(
    fakeRunner(),
    fakeLock(),
    () => {},
    new ApprovalCoordinator(() => {}),
    makeTestSessionStore(),
  );
  const first = manager.create(tmpDir);
  const second = manager.create(tmpDir); // 当前会话
  expect(existsSync(second.file)).toBe(true);

  manager.remove(tmpDir, path.basename(second.file));

  expect(existsSync(second.file)).toBe(false);
  const [cur] = manager.list();
  expect(cur!.file).toBe(first.file);
});

it("remove 删除唯一会话后新建空会话", () => {
  const manager = new SessionManager(
    fakeRunner(),
    fakeLock(),
    () => {},
    new ApprovalCoordinator(() => {}),
    makeTestSessionStore(),
  );
  const handle = manager.create(tmpDir);
  manager.remove(tmpDir, path.basename(handle.file));

  expect(existsSync(handle.file)).toBe(false);
  const [cur] = manager.list();
  expect(cur).toBeDefined();
  expect(cur!.file).not.toBe(handle.file);
  expect(cur!.messages).toEqual([{ role: "system", content: "sys" }]);
});

it("remove 删除非当前会话不影响当前会话", () => {
  const manager = new SessionManager(
    fakeRunner(),
    fakeLock(),
    () => {},
    new ApprovalCoordinator(() => {}),
    makeTestSessionStore(),
  );
  const first = manager.create(tmpDir);
  const second = manager.create(tmpDir); // 当前会话
  manager.remove(tmpDir, path.basename(first.file));

  expect(existsSync(first.file)).toBe(false);
  const [cur] = manager.list();
  expect(cur!.file).toBe(second.file);
});

it("remove 拒绝路径穿越", () => {
  const manager = new SessionManager(
    fakeRunner(),
    fakeLock(),
    () => {},
    new ApprovalCoordinator(() => {}),
    makeTestSessionStore(),
  );
  expect(() => manager.remove(tmpDir, "../etc/passwd")).toThrow("invalid session file");
});
```

在文件顶部 import 增加 `existsSync`：

```ts
import { existsSync, mkdtempSync, rmSync } from "node:fs";
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @blh/web-server test session.test.ts`

预期：FAIL，报错 `manager.remove is not a function`。

- [ ] **步骤 3：实现 `remove`**

在 `apps/web-server/src/session.ts` 的 `SessionManager` 类里、`dispose(id)` 方法之前插入：

```ts
  /** 删除会话文件；若删除的是当前会话，则跳到剩余最新会话，无剩余时新建空会话（维持「始终有活跃会话」不变量）。 */
  remove(workdir: string, file: string): void {
    if (path.basename(file) !== file || file === "." || file === "..") {
      throw new Error(`invalid session file: ${file}`);
    }
    const fullPath = path.join(this.sessionStore.sessionsDir(workdir), file);
    this.sessionStore.remove(fullPath);
    if (this.current !== undefined && this.current.file === fullPath) {
      this.current = undefined;
      const next = this.sessionStore.latest(workdir);
      if (next !== null) {
        this.resume(workdir, path.basename(next));
      } else {
        this.create(workdir);
      }
    }
    log.debug("session removed", { file: fullPath });
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @blh/web-server test session.test.ts`

预期：PASS（含四个新增用例）。

- [ ] **步骤 5：Commit**

```bash
git add apps/web-server/src/session.ts apps/web-server/test/session.test.ts
git commit -m "feat(web-server): add SessionManager.remove"
```

### 任务 1.4 HTTP 路由 `POST /api/session/delete`

**文件：**
- 修改：`apps/web-server/src/http.ts`
- 测试：`apps/web-server/test/http.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `apps/web-server/test/http.test.ts` 的 `describe("http 路由")` 内、`POST /api/session/resume 拒绝点号目录` 用例之后追加：

```ts
it("POST /api/session/delete 删除会话文件", async () => {
  const { server, url } = await listen(makeContext(tmpDir));
  servers.push(server);
  const sessionsDir = path.join(tmpDir, ".sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const target = path.join(sessionsDir, "session_del.jsonl");
  writeFileSync(target, JSON.stringify({ role: "user", content: "x" }) + "\n");
  const res = await fetch(`${url}/api/session/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-blh-web": "1" },
    body: JSON.stringify({ file: "session_del.jsonl" }),
  });
  expect(res.status).toBe(200);
  expect(existsSync(target)).toBe(false);
});

it("POST /api/session/delete 拒绝路径穿越", async () => {
  const { server, url } = await listen(makeContext(tmpDir));
  servers.push(server);
  const res = await fetch(`${url}/api/session/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-blh-web": "1" },
    body: JSON.stringify({ file: ".." }),
  });
  expect(res.status).toBe(400);
});
```

在文件顶部 import 增加 `existsSync`：

```ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @blh/web-server test http.test.ts`

预期：FAIL（两个新用例返回 404，因为路由未注册）。

- [ ] **步骤 3：实现路由**

在 `apps/web-server/src/http.ts` 的 `POST /api/session/resume` 分支之后、`json(res, 404, ...)` 之前插入：

```ts
  if (method === "POST" && pathname === "/api/session/delete") {
    const body = (await readBody(req)) as Record<string, unknown>;
    const file = typeof body.file === "string" ? body.file : "";
    if (file === "") {
      json(res, 400, { error: "file is required" });
      return;
    }
    if (path.basename(file) !== file || file === "." || file === "..") {
      json(res, 400, { error: "invalid session file" });
      return;
    }
    ctx.session.remove(ctx.workdir, file);
    json(res, 200, { ok: true });
    return;
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @blh/web-server test http.test.ts`

预期：PASS（含两个新增用例）。

- [ ] **步骤 5：Commit**

```bash
git add apps/web-server/src/http.ts apps/web-server/test/http.test.ts
git commit -m "feat(web-server): add POST /api/session/delete"
```

### 任务 1.5 客户端 API

**文件：** 修改 `packages/web-client/src/api.ts`

- [ ] **步骤 1：实现 `deleteSession`**

在 `apps/web/.../api.ts`（即 `packages/web-client/src/api.ts`）文件末尾 `resumeSession` 之后追加：

```ts
export async function deleteSession(file: string): Promise<unknown> {
  return request("/api/session/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file }),
  });
}
```

- [ ] **步骤 2：typecheck 验证**

运行：`pnpm --filter @blh/web-client typecheck`

预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add packages/web-client/src/api.ts
git commit -m "feat(web-client): add deleteSession api"
```

---

## 任务 2：设计 token + 全局样式重写

**文件：**
- 修改：`apps/web/src/styles.css`（整文件重写）
- 修改：`apps/web/index.html`

本任务把 deepseek-harness 的浅色主题 token 与 sidebar 布局规则落地。token 值全部取自 `deepseek-harness/packages/client/ui-theme/src/styles/{design-platform.css,base.css,gradient-shadow-text.css}` 与 `ui-sidebar/src/client/SidebarRoot.module.css`，不臆造。

- [ ] **步骤 1：重写 `apps/web/src/styles.css`**

将整个文件内容替换为：

```css
/* ============ reset & base ============ */
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
}
button, input, select, textarea { font-family: inherit; }

/* ============ motion tokens ============ */
:root {
  --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ds-transition-duration-fast: 0.1s;
  --ds-transition-duration: 0.2s;
  --ds-transition-duration-slow: 0.3s;
}

/* ============ static palette (light) ============ */
:root {
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-60: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-150: rgb(233, 236, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-500: rgb(151, 157, 166);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-750: rgb(67, 69, 74);
  --dsw-static-neutral-bluish-800: rgb(53, 54, 56);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-900: rgb(27, 27, 28);
  --dsw-static-neutral-bluish-950: rgb(21, 21, 23);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-deepseek-50: rgb(237, 243, 254);
  --dsw-static-deepseek-100: rgb(228, 237, 253);
  --dsw-static-deepseek-200: rgb(211, 226, 255);
  --dsw-static-deepseek-400: rgb(103, 158, 254);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-green-100: rgb(230, 250, 237);
  --dsw-static-green-400: rgb(78, 209, 126);
  --dsw-static-green-500: rgb(34, 197, 94);
  --dsw-static-red-50: rgb(254, 242, 242);
  --dsw-static-red-100: rgb(254, 226, 226);
  --dsw-static-red-400: rgb(242, 90, 90);
  --dsw-static-red-500: rgb(239, 68, 68);
  --dsw-static-red-600: rgb(236, 19, 19);
  --dsw-static-amber-100: rgb(254, 245, 231);
  --dsw-static-amber-500: rgb(245, 158, 11);
}

/* ============ semantic aliases (light) ============ */
:root {
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-150);
  --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
  --dsw-alias-border-l2: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l2-darkmode-thin: rgba(0, 0, 0, 0.1);
  --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
  --dsw-alias-border-inverted: rgba(0, 0, 0, 0);
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-brand-text: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-button-elevated-fill: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-button-floating-hover: var(--dsw-static-neutral-bluish-75);
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
  --dsw-alias-interactive-bg-hover-danger: rgba(236, 19, 19, 0.05);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-state-error-primary: var(--dsw-static-red-600);
  --dsw-alias-state-error-secondary: var(--dsw-static-red-400);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-50);
  --dsw-specific-sidebar-nav-item-active: var(--dsw-static-neutral-bluish-100);
  --dsw-specific-sidebar-nav-item-hover: var(--dsw-static-neutral-bluish-75);
  --dsw-specific-menu: var(--dsw-alias-bg-layer-3);
  --dsw-shadow-lv3:
    0 0 1px 0 rgba(0, 0, 0, 0.2), 0 0 4px 0 rgba(0, 0, 0, 0.02), 0 12px 32px 0 rgba(0, 0, 0, 0.08);
}

/* ============ app shell（两栏：sidebar + main） ============ */
.app {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  height: 100%;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.app.app-collapsed {
  grid-template-columns: 56px minmax(0, 1fr);
}
@media (prefers-reduced-motion: reduce) {
  .app { transition: none; }
}

.main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}

/* ============ sidebar shell ============ */
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 6px 12px;
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  border-right: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
}
.sidebar.sidebar-collapsed {
  padding: 18px 10px 6px;
}

.logo-row {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  height: 60px;
  padding: 8px 0 8px 4px;
  margin-bottom: 8px;
  overflow: hidden;
}
.sidebar-collapsed .logo-row {
  height: 36px;
  padding: 0;
  margin-bottom: 12px;
  justify-content: flex-start;
}

.brand {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  overflow: hidden;
}
.brand-identity {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  min-width: 0;
}
.brand-mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.brand-name {
  display: inline-flex;
  align-items: center;
  height: 24px;
  font-size: 17px;
  font-weight: 600;
  line-height: 24px;
  white-space: nowrap;
}

.icon-button {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sidebar-collapsed .icon-button { width: 36px; height: 36px; color: var(--dsw-alias-label-primary); }

.new-session {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  padding: 8px 16px;
  margin: 0 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-button-elevated-fill);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  cursor: pointer;
  overflow: hidden;
}
.new-session:hover { background: var(--dsw-alias-button-floating-hover); }
.sidebar-collapsed .new-session {
  align-self: flex-start;
  width: 36px;
  height: 36px;
  padding: 0;
  margin: 0 0 12px;
  gap: 0;
  border-color: transparent;
  background: transparent;
}
.sidebar-collapsed .new-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
.new-session-label { max-width: 200px; overflow: hidden; white-space: nowrap; }
.sidebar-collapsed .new-session-label { max-width: 0; }

.session-region {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

/* ============ session list ============ */
.session-list { list-style: none; margin: 0; padding: 0; }
.session-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; padding: 6px 8px; }

.session-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  height: 32px;
  border-radius: 8px;
  padding: 0 8px;
  cursor: pointer;
  user-select: none;
  color: var(--dsw-alias-label-primary);
}
.session-row:hover,
.session-row.selected,
.session-row.menu-open { background: var(--dsw-alias-interactive-bg-hover); }

.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 20px;
}
.session-time {
  flex: none;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
.session-row:hover .session-time,
.session-row.menu-open .session-time { display: none; }

.session-actions {
  flex: none;
  display: none;
  align-items: center;
}
.session-row:hover .session-actions,
.session-row.menu-open .session-actions { display: inline-flex; }

/* ============ dropdown menu ============ */
.menu-anchor { position: relative; display: inline-flex; }
.menu-list {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  box-sizing: border-box;
  min-width: 218px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-shadow-lv3);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.menu-item.danger { color: var(--dsw-alias-state-error-primary); }
.menu-item.danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.menu-item-icon {
  display: inline-flex;
  flex: none;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
}
.menu-item.danger .menu-item-icon { color: var(--dsw-alias-state-error-primary); }

/* ============ chat panel ============ */
.chat-panel { flex: 1; overflow-y: auto; padding: 24px 32px; }
.bubble { margin-bottom: 12px; display: flex; flex-direction: column; max-width: 80%; }
.bubble-user { align-items: flex-end; margin-left: auto; }
.bubble-assistant { align-items: flex-start; }
.bubble-role { font-size: 11px; color: var(--dsw-alias-label-caption); margin-bottom: 4px; }
.bubble-text {
  padding: 10px 14px;
  border-radius: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 15px;
  line-height: 24px;
}
.bubble-user .bubble-text { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted); }
.bubble-assistant .bubble-text { background: var(--dsw-static-neutral-bluish-75); color: var(--dsw-alias-label-primary); }

/* ============ tool card ============ */
.tool-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
  background: var(--dsw-alias-bg-base);
}
.tool-card-error { border-color: var(--dsw-alias-state-error-secondary); }
.tool-card-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
.tool-card-args, .tool-card-output {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}

/* ============ error banner ============ */
.error-banner {
  padding: 8px 16px;
  background: var(--dsw-static-red-50);
  color: var(--dsw-alias-state-error-primary);
  border-top: 1px solid var(--dsw-alias-state-error-secondary);
}

/* ============ input bar ============ */
.input-bar { display: flex; gap: 8px; padding: 12px 24px 20px; border-top: 1px solid var(--dsw-alias-border-l1); }
.input-bar input {
  flex: 1;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  outline: none;
}
.input-bar input:focus { border-color: var(--dsw-alias-label-tertiary); }
.input-bar input:disabled { opacity: 0.5; }
.input-bar button {
  flex: none;
  padding: 0 20px;
  border: none;
  border-radius: 12px;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.input-bar button:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.input-bar button:disabled { opacity: 0.4; cursor: not-allowed; }

/* ============ modal ============ */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: var(--dsw-alias-bg-base);
  border-radius: 16px;
  padding: 24px;
  width: 480px;
  max-width: 90vw;
  box-shadow: var(--dsw-shadow-lv3);
}
.modal h2 { margin: 0 0 12px; font-size: 18px; line-height: 26px; }
.modal-args {
  background: var(--dsw-static-neutral-bluish-75);
  padding: 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 20px;
  overflow: auto;
  max-height: 200px;
}
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.modal-actions button {
  padding: 8px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  cursor: pointer;
}
.modal-actions button:hover { background: var(--dsw-alias-button-floating-hover); }
.modal-actions button.primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
  border: none;
}
.modal-actions button.primary:hover { background: var(--dsw-alias-button-primary-hover); }
```

- [ ] **步骤 2：修改 `index.html` 标题**

将 `apps/web/index.html` 的 `<title>blh 工作台</title>` 改为 `<title>blh</title>`。

- [ ] **步骤 3：typecheck + build 验证**

运行：`pnpm --filter @blh/web typecheck`

预期：通过（本任务仅改 CSS/HTML，不影响 TS）。

- [ ] **步骤 4：Commit**

```bash
git add apps/web/src/styles.css apps/web/index.html
git commit -m "feat(web): adopt deepseek-harness light theme tokens and shell layout"
```

---

## 任务 3：Logo 组件 + 折叠布局骨架

**文件：**
- 创建：`apps/web/src/components/Logo.tsx`
- 创建：`apps/web/src/components/icons.tsx`
- 修改：`apps/web/src/App.tsx`
- 修改：`apps/web/src/components/SessionSidebar.tsx`（骨架：logo 行 + 折叠 + 新建）

- [ ] **步骤 1：创建 `Logo.tsx`**

`apps/web/src/components/Logo.tsx` 内容：

```tsx
/** blh 品牌标识：圆角方块 + 抽象「b」形，颜色跟随 currentColor。 */
export function BlhLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="currentColor" />
      <path d="M8 7.25h2.9a2.5 2.5 0 0 1 0 5H8v-5Zm0 5h4.1a2.5 2.5 0 0 1 0 5H8v-5Z" fill="#ffffff" />
    </svg>
  );
}
```

- [ ] **步骤 2：创建 `icons.tsx`**

`apps/web/src/components/icons.tsx` 内容：

```tsx
/** 内联 SVG 图标（16px 网格，颜色跟随 currentColor）。 */

export function IconPanelLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconEllipsis({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}

export function IconTrash({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
```

- [ ] **步骤 3：修改 `App.tsx` 持有折叠状态、移除顶部 topbar**

将 `apps/web/src/App.tsx` 替换为：

```tsx
import { useState } from "react";
import { useAgentEvents } from "./hooks/useAgentEvents";
import { ChatPanel } from "./components/ChatPanel";
import { InputBar } from "./components/InputBar";
import { ApprovalModal } from "./components/ApprovalModal";
import { SessionSidebar } from "./components/SessionSidebar";

export function App() {
  const state = useAgentEvents();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app${collapsed ? " app-collapsed" : ""}`}>
      <SessionSidebar
        sessions={state.sessions}
        activeId={state.sessionId}
        loading={state.sessionLoading}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        onNew={() => void state.createSession()}
        onResume={(file) => void state.resume(file)}
      />
      <main className="main">
        <ChatPanel
          messages={state.messages}
          streaming={state.streaming}
          toolEvents={state.toolEvents}
          busy={state.busy}
          approval={state.approval}
        />
        {state.error !== null && <div className="error-banner">{state.error}</div>}
        <InputBar busy={state.busy} onSend={(text) => void state.send(text)} />
      </main>
      <ApprovalModal approval={state.approval} onRespond={(d) => void state.respond(d)} />
    </div>
  );
}
```

- [ ] **步骤 4：重写 `SessionSidebar.tsx`（骨架，先不含三点删除菜单）**

将 `apps/web/src/components/SessionSidebar.tsx` 替换为：

```tsx
import type { SessionListItem } from "@blh/web-client";
import { BlhLogo } from "./Logo";
import { IconPanelLeft, IconPlus } from "./icons";

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  collapsed: boolean;
  onToggle(): void;
  onNew(): void;
  onResume(file: string): void;
}) {
  const { sessions, activeId, loading, collapsed, onToggle, onNew, onResume } = props;
  return (
    <aside className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}>
      <div className="logo-row">
        {!collapsed && (
          <button type="button" className="brand" aria-label="新建会话" onClick={onNew}>
            <span className="brand-identity">
              <span className="brand-mark">
                <BlhLogo size={24} />
              </span>
              <span className="brand-name">blh</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggle}
        >
          <IconPanelLeft size={16} />
        </button>
      </div>

      <button type="button" className="new-session" aria-label="新建会话" onClick={onNew} disabled={loading}>
        <IconPlus size={14} />
        <span className="new-session-label">{loading ? "加载中…" : "新建会话"}</span>
      </button>

      <div className="session-region">
        {collapsed ? null : (
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.file}>
                <button
                  className={`session-row${s.file === activeId ? " selected" : ""}`}
                  onClick={() => onResume(s.file)}
                  disabled={loading}
                >
                  <span className="session-title">{s.preview !== "" ? s.preview : s.file}</span>
                </button>
              </li>
            ))}
            {sessions.length === 0 && !loading && <li className="session-empty">暂无会话</li>}
          </ul>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **步骤 5：typecheck + build 验证**

运行：`pnpm --filter @blh/web typecheck`

预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add apps/web/src/components/Logo.tsx apps/web/src/components/icons.tsx apps/web/src/App.tsx apps/web/src/components/SessionSidebar.tsx
git commit -m "feat(web): add brand logo and collapsible sidebar shell"
```

---

## 任务 4：会话列表悬停三点 + 删除菜单

**文件：**
- 修改：`apps/web/src/hooks/useAgentEvents.ts`（新增 `deleteSession`）
- 修改：`apps/web/src/components/SessionSidebar.tsx`（完整：时间显示 + 三点菜单 + 删除）
- 修改：`apps/web/src/App.tsx`（透传 `onDelete`）

- [ ] **步骤 1：hook 新增 `deleteSession`**

修改 `apps/web/src/hooks/useAgentEvents.ts`：

在 import 处，把 `deleteSession` 重命名引入，避免与本地方法名冲突：

```ts
import {
  connectEvents,
  deleteSession as deleteSessionApi,
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
```

在 `AgentState` 接口的 `resume(file: string): Promise<void>;` 之后加：

```ts
  deleteSession(file: string): Promise<void>;
```

在 `resume` 的 `useCallback` 之后加：

```ts
  const deleteSession = useCallback(
    async (file: string) => {
      try {
        await deleteSessionApi(file);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? `删除会话失败：${e.message}` : "删除会话失败");
        log.error("delete session failed", {}, e);
      }
    },
    [refresh],
  );
```

在最终 `return { ... }` 对象里，`resume,` 之后加：

```ts
    deleteSession,
```

- [ ] **步骤 2：`SessionSidebar` 增加三点菜单 + 删除**

将 `apps/web/src/components/SessionSidebar.tsx` 整文件替换为：

```tsx
import { useEffect, useRef, useState } from "react";
import type { SessionListItem } from "@blh/web-client";
import { BlhLogo } from "./Logo";
import { IconEllipsis, IconPanelLeft, IconPlus, IconTrash } from "./icons";

/** 相对时间文案（与 deepseek 的会话行 trailing 时间一致，简体中文短格式）。 */
function timeLabel(mtime: number): string {
  const diff = Date.now() - mtime;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.floor(hours / 24)}天`;
}

/** 单条会话行：悬停时时间替换为三点菜单，菜单含「删除」。 */
function SessionRow(props: {
  session: SessionListItem;
  active: boolean;
  onOpen(): void;
  onDelete(): void;
}) {
  const { session, active, onOpen, onDelete } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (anchorRef.current !== null && !anchorRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <li>
      <div
        className={`session-row${active ? " selected" : ""}${menuOpen ? " menu-open" : ""}`}
        onClick={onOpen}
      >
        <span className="session-title">{session.preview !== "" ? session.preview : session.file}</span>
        <span className="session-time">{timeLabel(session.mtime)}</span>
        <span className="session-actions">
          <div className="menu-anchor" ref={anchorRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="会话操作"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
            >
              <IconEllipsis size={16} />
            </button>
            {menuOpen && (
              <div className="menu-list" role="menu">
                <button
                  type="button"
                  className="menu-item danger"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <span className="menu-item-icon"><IconTrash size={16} /></span>
                  <span>删除会话</span>
                </button>
              </div>
            )}
          </div>
        </span>
      </div>
    </li>
  );
}

export function SessionSidebar(props: {
  sessions: SessionListItem[];
  activeId: string | null;
  loading: boolean;
  collapsed: boolean;
  onToggle(): void;
  onNew(): void;
  onResume(file: string): void;
  onDelete(file: string): void;
}) {
  const { sessions, activeId, loading, collapsed, onToggle, onNew, onResume, onDelete } = props;
  return (
    <aside className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}>
      <div className="logo-row">
        {!collapsed && (
          <button type="button" className="brand" aria-label="新建会话" onClick={onNew}>
            <span className="brand-identity">
              <span className="brand-mark"><BlhLogo size={24} /></span>
              <span className="brand-name">blh</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
          onClick={onToggle}
        >
          <IconPanelLeft size={16} />
        </button>
      </div>

      <button type="button" className="new-session" aria-label="新建会话" onClick={onNew} disabled={loading}>
        <IconPlus size={14} />
        <span className="new-session-label">{loading ? "加载中…" : "新建会话"}</span>
      </button>

      <div className="session-region">
        {collapsed ? null : (
          <ul className="session-list">
            {sessions.map((s) => (
              <SessionRow
                key={s.file}
                session={s}
                active={s.file === activeId}
                onOpen={() => onResume(s.file)}
                onDelete={() => onDelete(s.file)}
              />
            ))}
            {sessions.length === 0 && !loading && <li className="session-empty">暂无会话</li>}
          </ul>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **步骤 3：`App.tsx` 透传 `onDelete`**

修改 `apps/web/src/App.tsx`，在 `<SessionSidebar ... />` 的 props 里，`onResume` 之后加：

```tsx
          onDelete={(file) => void state.deleteSession(file)}
```

- [ ] **步骤 4：typecheck + build 验证**

运行：`pnpm --filter @blh/web typecheck`

预期：通过。

- [ ] **步骤 5：Commit**

```bash
git add apps/web/src/hooks/useAgentEvents.ts apps/web/src/components/SessionSidebar.tsx apps/web/src/App.tsx
git commit -m "feat(web): add session hover ellipsis menu with delete"
```

---

## 任务 5：Chat / Input / Tool / Modal 样式统一

本任务仅替换这些组件的 `className` 与少量结构，使它们落在任务 2 已定义的新样式上。不改动业务逻辑。

**文件：**
- 修改：`apps/web/src/components/ChatPanel.tsx`
- 修改：`apps/web/src/components/InputBar.tsx`
- 修改：`apps/web/src/components/ToolCallCard.tsx`
- 修改：`apps/web/src/components/ApprovalModal.tsx`

- [ ] **步骤 1：`ChatPanel.tsx`**

`ChatPanel.tsx` 当前类名已是 `bubble` / `bubble-role` / `bubble-text`（与任务 2 定义一致），无需改动。若 `bubble-tool` 样式在任务 2 已移除，`ChatPanel` 中 tool 消息角色不再走 `.bubble-tool`，检查 `messages.filter((m) => m.role !== "system")` 渲染即可，无 tool 气泡分支。**本文件跳过。**

- [ ] **步骤 2：`InputBar.tsx`**

`InputBar.tsx` 当前类名 `input-bar` 已对齐任务 2，结构一致（`input` + `button`），无需改动。**本文件跳过。**

- [ ] **步骤 3：`ToolCallCard.tsx` 状态文案保留、类名已对齐**

`ToolCallCard.tsx` 当前类名 `tool-card` / `tool-card-error` / `tool-card-head` / `tool-card-args` / `tool-card-output` 已对齐任务 2，无需改动。**本文件跳过。**

- [ ] **步骤 4：`ApprovalModal.tsx` 主按钮加 `primary` 类**

修改 `apps/web/src/components/ApprovalModal.tsx` 的 `modal-actions` 块，给「允许」「总是允许」按钮加 `primary`，保持「拒绝」为普通按钮：

```tsx
        <div className="modal-actions">
          <button onClick={() => onRespond("deny")}>拒绝</button>
          <button className="primary" onClick={() => onRespond("allow")}>允许</button>
          <button className="primary" onClick={() => onRespond("always_allow")}>总是允许</button>
        </div>
```

- [ ] **步骤 5：typecheck + build 验证**

运行：`pnpm --filter @blh/web typecheck`

预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add apps/web/src/components/ApprovalModal.tsx
git commit -m "feat(web): style approval modal primary actions"
```

---

## 任务 6：e2e 更新 + 全量验证

**文件：**
- 修改：`apps/web/e2e/mock-server.mjs`（支持删除路由）
- 修改：`apps/web/e2e/workbench.spec.ts`（更新标题断言 + 新增折叠/删除用例）

- [ ] **步骤 1：mock-server 增加删除与列表支持**

修改 `apps/web/e2e/mock-server.mjs`：

在 `const history = [];` 之后加一个内存会话列表：

```js
const sessions = [
  { file: "session_1.jsonl", mtime: Date.now(), preview: "历史会话" },
];
```

把 `GET /api/sessions` 分支的返回改为：

```js
  if (method === "GET" && pathname === "/api/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions }));
    return;
  }
```

新增删除分支（放在 `POST /api/__reset` 之前）：

```js
  if (method === "POST" && pathname === "/api/session/delete") {
    const body = await readJson(req);
    const file = (body.file ?? "").toString();
    const idx = sessions.findIndex((s) => s.file === file);
    if (idx >= 0) sessions.splice(idx, 1);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
```

- [ ] **步骤 2：更新 e2e 用例**

修改 `apps/web/e2e/workbench.spec.ts`：

把第一个用例改为检查品牌标识：

```ts
test("工作台加载并显示品牌标识", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("blh", { exact: true })).toBeVisible();
});
```

在文件末尾追加两个用例：

```ts
test("折叠侧边栏", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "折叠侧边栏" }).click();
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
});

test("悬停会话显示三点并可删除", async ({ page }) => {
  await page.goto("/");
  const row = page.getByText("历史会话");
  await row.hover();
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  await expect(page.getByText("历史会话")).toHaveCount(0);
});
```

- [ ] **步骤 3：全量 typecheck**

运行：`pnpm typecheck`

预期：通过（根包 + 各 workspace 包）。

- [ ] **步骤 4：全量后端单测**

运行：`pnpm test && pnpm --filter @blh/web-server test && pnpm --filter @blh/web-client test`

预期：全部 PASS。

- [ ] **步骤 5：前端构建**

运行：`pnpm build:web`

预期：构建成功，无报错。

- [ ] **步骤 6：Commit**

```bash
git add apps/web/e2e/mock-server.mjs apps/web/e2e/workbench.spec.ts
git commit -m "test(web): cover collapse and session delete in e2e"
```

---

## 自检记录

**规格覆盖度：** 用户三条诉求逐项映射——
1. 左上角 logo → 任务 3 `Logo.tsx` + `SessionSidebar` logo 行；
2. logo 旁折叠 → 任务 2/3 `.app` grid 折叠 + `icon-button` 折叠按钮；
3. 会话列表悬停三点删除 → 任务 1（后端）+ 任务 4（前端三点菜单）。样式对齐 → 任务 2 token + 任务 5 组件统一。均已覆盖。

**占位符扫描：** 无「TODO / 待定 / 后续实现」；每个代码步骤均含完整实现。

**类型一致性：** `deleteSession` 在 web-client 导出、hook 中 `deleteSession as deleteSessionApi` 引入、`AgentState.deleteSession(file: string)` 签名一致；`SessionStoreModule.remove` 与 `SessionStore.remove` 签名一致；`SessionManager.remove(workdir, file)` 与 http 路由调用一致。

**已知取舍：**
- 仅实现浅色主题（深色切换属「我们没有的功能」，不实现）。
- 折叠为纯 CSS grid 过渡（无 deepseek 的 slide+crossfade 冻结宽度动画与拖拽手柄、自动折叠断点），保持功能等价、实现简洁。
- 删除当前会话后跳到剩余最新会话，无剩余时新建空会话，维持后端「始终有活跃会话」不变量。
- Logo 图形为 blh 抽象标识（可替换占位），位置/尺寸/颜色对齐 deepseek 的 logo 行规范。
