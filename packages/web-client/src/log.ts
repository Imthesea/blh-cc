import type { LogEntry } from "@blh/logger";

/** 把前端日志回传后端落盘；失败静默降级（不抛错，避免触发新的远程日志）。 */
export async function reportLogs(entries: LogEntry[]): Promise<void> {
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ entries }),
    });
  } catch {
    // 忽略：回传失败不致命
  }
}
