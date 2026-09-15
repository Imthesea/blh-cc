import type { Config } from "./types.js";

export function loadConfig(workdir?: string): Config {
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
