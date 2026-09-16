# blh

一个运行在命令行里的编码 Agent（TypeScript 版），通过 OpenAI 兼容 API 与模型交互，可调用 bash 与文件工具完成编码任务。

## 安装

要求 Node.js >= 20 与 pnpm。

```powershell
pnpm install
pnpm build
```

构建产物输出到 `dist/`，入口为 `dist/cli/main.js`（`package.json` 的 `bin` 名称为 `blh`）。

## 快速开始

### 1. 配置 API Key

在项目根目录（或任意向上查找得到的目录）放一个 `.env`：

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
# 可选：使用兼容网关时指定
OPENAI_BASE_URL=https://api.openai.com/v1
```

也可用 YAML 配置（见下文「配置」）。

### 2. 交互式运行

```powershell
pnpm dev
```

进入 REPL 后直接输入指令即可。`/goal <目标>` 设置本轮目标，`/help` 查看命令。

### 3. 单次对话（`-p`）

```powershell
pnpm dev -- -p "解释 src/core/config.ts 的作用"
```

## 配置

配置按「低优先级在前、高优先级在后」合成，最终取最高优先级命中的值：

```
内置默认 < 配置文件 < 环境变量 < CLI 参数
```

| 键 | 环境变量 | CLI 参数 | 默认值 |
|---|---|---|---|
| `api_key` | `OPENAI_API_KEY` | — | 无（缺失则退出） |
| `base_url` | `OPENAI_BASE_URL` | `--base-url` | 无 |
| `model` | `OPENAI_MODEL` | `--model` | `gpt-4o-mini` |
| `workdir` | — | `--workdir` | 当前目录 |
| `bash_timeout` | `BLH_BASH_TIMEOUT` | `--bash-timeout` | `120` |
| `max_output_chars` | `BLH_MAX_OUTPUT_CHARS` | `--max-output-chars` | `30000` |

### 配置文件

- 用户级：`~/.config/blh/config.yaml`
- 项目级：`.blh.yaml`（从当前目录向上查找第一个）

两个文件均存在时，用户级先读、项目级后读，后读覆盖先读。YAML 使用 snake_case 键名：

```yaml
api_key: sk-...
base_url: https://api.openai.com/v1
model: gpt-4o-mini
workdir: .
bash_timeout: 120
max_output_chars: 30000
```

CLI 参数同样映射到上述键，优先级最高：

```powershell
pnpm dev -- --model deepseek-chat --base-url https://example.com/v1
```

## 功能清单

- **M0 基础**：REPL / `-p` 单次对话，5 个内置工具（bash、read_file、write_file、edit_file、glob），PreToolUse 权限规则，429/5xx 自动重试。
- **M1 上下文**：上下文压缩（compaction）、计划与追踪（planning）、长期记忆（memory）。
- **M2 异步与调度**：后台 bash 任务（`run_in_background`）、cron 调度（`schedule_cron`/`list_crons`/`cancel_cron`）。
- **M3 多智能体**：一次性 subagent（`task`）、文件收件箱、git worktree、持久队友与团队工具。
- **M4 扩展**：技能按需加载（`load_skill`）、MCP 客户端与多连接注册（`connect_mcp`）。
- **M5 编排与目标闭环**：`run_workflow` 内置工作流（journal 断点恢复）、session 级目标闭环（`/goal`）。
- **M6 打磨与发布**：四层配置、CLI 参数解析、Retry-After 与退避抖动。

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 用 tsx 运行 CLI |
| `pnpm build` | tsc 构建到 `dist/` |
| `pnpm typecheck` | 类型检查（不产出） |
| `pnpm test` | 运行 vitest 全量测试 |
| `pnpm lint` | ESLint 检查 |
