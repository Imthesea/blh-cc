import type { LogEntry } from "@blh/logger";

/** 把前端日志回传后端落盘；失败静默降级（不抛错，避免触发新的远程日志）。 */
export async function reportLogs(entries: LogEntry[]): Promise<void> {
  try {
    const res = await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-blh-web": "1" },
      body: JSON.stringify({ entries }),
    });
    if (!res.ok) {
      // 用原生 console 而非 logger，避免回传失败自身再次触发回传
      console.warn(`[logger] log report failed: HTTP ${res.status}`);
    }
  } catch {
    console.warn("[logger] log report failed: server unreachable");
  }
}
