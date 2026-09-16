# blh-claude-code-ts M6:打磨与发布 实现计划

> **状态**:已实施(2026-09-16,六项任务全部完成,验证通过)

- **日期**:2026-09-16
- **依据**:`F:\allProject\myProject\blh-claude-code\docs\plans\2026-09-14-m6-polish-release.md` + `.../m6-polish-release-design.md`(Python 蓝本)
- **方法**:TDD(config/retry),README/package.json 为文档与验证任务
- **零新依赖**:CLI 参数用 Node 20 内置 `node:util` 的 `parseArgs`;YAML 用已存在的 `yaml` 依赖

## 关键适配决策

| 决策点 | 结论 |
|---|---|
| 环境变量 model | **保留 `OPENAI_MODEL`**(与 Python 蓝本的 `BLH_MODEL` 不同,TS 沿用既有约定,不动 `.env` 与现有 config 测试) |
| 配置文件格式/键名 | YAML,键名用 **snake_case**(`api_key`/`base_url`/`model`/`workdir`/`bash_timeout`/`max_output_chars`),与 Python 的 `.blh.yaml` 完全兼容 |
| 配置文件位置 | 用户级 `~/.config/blh/config.yaml` + 项目级 `.blh.yaml`(从 cwd 向上找第一个),低优先级在前,后读覆盖先读 |
| 优先级 | 内置默认 < 配置文件 < 环境变量 < CLI 参数 |
| 异常 | 新增 `ConfigError`;缺失 api_key 沿用 `process.exit(1)` 语义 |
| retry 抖动 | `base = min(2**attempt, 32)`,返回 `base * random(0.5, 1.5)`;429 的 `Retry-After`(>0)优先且不封顶 |
| CLI 解析 | `node:util` `parseArgs`(`--model`/`--base-url`/`--workdir`/`--bash-timeout`/`--max-output-chars`/`-p,--print`) |
| 发布动作 | 只做 `package.json` 元数据补齐 + `pnpm build` 验证,不执行真实 `npm publish` |

## 任务总览

| # | 任务 | 产物 |
|---|---|---|
| 1 | Config 分层加载(文件 + env + CLI) | `src/core/config.ts` |
| 2 | CLI 参数接入 | `src/cli/main.ts` |
| 3 | retry:Retry-After + 抖动 | `src/providers/retry.ts` |
| 4 | README | `README.md` |
| 5 | package.json 元数据 + 打包验证 | `package.json` |
| 6 | 收尾验证 | vitest + lint + typecheck + build |

---

## 任务 1:Config 分层加载(`src/core/config.ts`)

### 1.1 失败测试(修改 `test/core/config.test.ts`)

新增 describe `loadConfig file/cli`:

```ts
it("file overrides defaults", ...)        // 项目 .blh.yaml: model=file-model, max_output_chars=123
it("env overrides file", ...)             // .blh.yaml model=file-model + OPENAI_MODEL=env-model → env-model
it("cli overrides all", ...)              // file+env + cli={model:"cli-model"} → cli-model
it("invalid int raises ConfigError", ...) // BLH_BASH_TIMEOUT=abc → ConfigError
it("user config then project config (project wins)", ...)
it("config file non-mapping raises ConfigError", ...)
```

环境变量 model 继续用 `OPENAI_MODEL`(不修改现有 env 断言)。

### 1.2 实现

- 新增 `ConfigError`。
- `findConfig(start)` 返回 `[用户级 ~/.config/blh/config.yaml, 项目级 .blh.yaml]`(仅存在的)。
- `toInt(value, key)` 失败抛 `ConfigError`。
- `loadConfig(workdir?, cli?)`:`.env` → 配置文件(合并) → env → cli 四层合成;snake_case 文件键映射到 camelCase `Config` 字段。

### 1.3 验证

```powershell
pnpm vitest run test/core/config.test.ts
```

---

## 任务 2:CLI 参数接入(`src/cli/main.ts`)

### 2.1 失败测试(追加 `test/cli/main.test.ts`)

新增 `parseCliArgs` 的 3 个测试:

```ts
it("parses model and base-url flags")
it("parses workdir/timeout/max-output flags")
it("parses -p prompt")
```

### 2.2 实现

- 新增导出 `parseCliArgs(argv)`(用 `node:util` `parseArgs`),返回 `{ prompt?, workdir?, cli }`。
- `buildHarness(workdir?, cli?)` 增加 `cli` 形参,内部 `loadConfig(workdir, cli)`。
- `main()` 用 `parseCliArgs`,组装非空 `cli` 传入 `buildHarness`。

### 2.3 验证

```powershell
pnpm vitest run test/cli/main.test.ts
```

---

## 任务 3:retry(`src/providers/retry.ts`)

### 3.1 失败测试(修改 `test/providers/retry.test.ts`)

新增:

```ts
it("retryAfterSeconds from header")        // Retry-After: "3" → 3
it("retryAfterSeconds invalid returns undefined")
it("retryAfterSeconds no response returns undefined")
it("retryDelay prefers Retry-After")       // error Retry-After=7 → 7
it("retryDelay bounded and jittered")      // mock Math.random=1.0,retryDelay(10)=32
```

并把现有 `retryDelay` 用例(确定性 `1/2/32/32`)改为基于 jitter 的断言(如 mock `Math.random` 后断言,或断言范围)。

### 3.2 实现

- 新增 `retryAfterSeconds(error)`。
- `retryDelay(attempt, error?)`:`Retry-After`(>0)优先;否则 `base * random(0.5,1.5)`,`base=min(2**attempt,32)`。
- `withRetry` 捕获异常后把 `error` 传入 `retryDelay`。

### 3.3 验证

```powershell
pnpm vitest run test/providers/retry.test.ts
```

---

## 任务 4:README

新建 `README.md`,内容:一句话定位、安装(pnpm)、快速开始(`.env`/`.blh.yaml`、交互与 `-p`)、四层配置说明、M0–M6 功能清单、开发命令。无单测,人工检查。

---

## 任务 5:package.json 元数据 + 打包验证

补齐 `license`/`keywords`/`author`/`repository`(按仓库现状填,不虚构);验证:

```powershell
pnpm build
```

产出 `dist/`;随后 `node dist/cli/main.js --help` 确认入口可用。

---

## 任务 6:收尾验证

```powershell
pnpm vitest run
pnpm lint
pnpm typecheck
pnpm build
```

全部通过后,更新本计划文档状态为「已实施」,汇总 M6 完成。
