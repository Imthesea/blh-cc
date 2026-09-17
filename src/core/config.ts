import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("core.config");

/** 配置解析失败。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 从 start 目录开始，一层一层往上找第一个 .env 文件（必须是真实存在的普通文件）；找不到就返回 undefined。 */
function findDotenv(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".env");
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** 判断某个路径是不是真实存在的普通文件；不存在、或是个目录，都返回 false。 */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 按「优先级从低到高」收集要加载的配置文件：先用户级，再项目级；只保留真实存在的文件。 */
function findConfig(start: string): string[] {
  const files: string[] = [];
  const user = path.join(os.homedir(), ".config", "blh", "config.yaml");
  if (isFile(user)) files.push(user);
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".blh.yaml");
    if (isFile(candidate)) {
      files.push(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/** 把一个值转成整数；转不了（比如传了 "abc"）就抛错。用来校验配置里的数字项。 */
function toInt(value: unknown, key: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) {
    throw new ConfigError(`${key} 不是合法的整数: ${JSON.stringify(value)}`);
  }
  return Number.parseInt(text, 10);
}

/** 加载最终配置：按「命令行 > 环境变量 > 配置文件 > 默认值」的优先级合并，并校验 API key、超时等关键项。 */
export function loadConfig(workdir?: string, cli?: Record<string, unknown>): Config {
  const dotenv = findDotenv(process.cwd());
  if (dotenv) {
    loadDotenv({ path: dotenv }); // 已存在的环境变量优先，不覆盖
  }

  const cliValues = cli ?? {};

  const fileValues: Record<string, unknown> = {};
  for (const filePath of findConfig(process.cwd())) {
    const data: unknown = parseYaml(readFileSync(filePath, "utf8"));
    if (data === null || data === undefined) continue;
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new ConfigError(`配置文件 ${filePath} 必须是一个键值对映射`);
    }
    Object.assign(fileValues, data);
  }
  log.debug("配置已加载", { files: findConfig(process.cwd()) });

  /** 按优先级取一个配置值：命令行 > 环境变量 > 配置文件 > 默认值。 */
  const get = (key: string, envName: string | undefined, defaultValue: unknown): unknown => {
    const cliValue = cliValues[key];
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (envName !== undefined) {
      const env = process.env[envName];
      if (env !== undefined && env !== "") return env;
    }
    const fileValue = fileValues[key];
    if (fileValue !== undefined && fileValue !== null) return fileValue;
    return defaultValue;
  };

  const apiKey = String(get("api_key", "OPENAI_API_KEY", ""));
  if (!apiKey) {
    log.error("没有设置 OPENAI_API_KEY");
    process.exit(1);
  }
  const rawBaseUrl = get("base_url", "OPENAI_BASE_URL", undefined);
  const baseUrl = typeof rawBaseUrl === "string" && rawBaseUrl !== "" ? rawBaseUrl : undefined;
  const model = String(get("model", "OPENAI_MODEL", "gpt-4o-mini"));
  const workdirValue = String(get("workdir", undefined, workdir ?? process.cwd()));
  const bashTimeout = toInt(get("bash_timeout", "BLH_BASH_TIMEOUT", 120), "bash_timeout");
  const maxOutputChars = toInt(
    get("max_output_chars", "BLH_MAX_OUTPUT_CHARS", 30000),
    "max_output_chars",
  );

  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    workdir: workdirValue,
    bashTimeout,
    maxOutputChars,
  };
}
