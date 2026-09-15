import { config as loadDotenv } from "dotenv";
import { statSync } from "node:fs";
import * as path from "node:path";
import type { Config } from "./types.js";

/** 从 start 向上逐级查找第一个 .env 文件（必须存在且为普通文件） */
function findDotenv(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, ".env");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在或无权限，继续向上
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(workdir?: string): Config {
  const dotenv = findDotenv(process.cwd());
  if (dotenv) {
    loadDotenv({ path: dotenv }); // 已存在的环境变量优先，不覆盖
  }

  const apiKey = process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    console.error("OPENAI_API_KEY is not set");
    process.exit(1);
  }
  const baseUrl = process.env.OPENAI_BASE_URL || undefined;
  return {
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    workdir: workdir ?? process.cwd(),
    bashTimeout: 120,
    maxOutputChars: 30000,
  };
}
