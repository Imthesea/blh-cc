import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { CoreLogger, fileDate, formatFile, formatTerminal } from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile } from "./format.js";

let currentLevel: LogLevel = "info";
let logDir: string | null = null;

function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

export function initLogger(workdir: string, level?: LogLevel): void {
  currentLevel = level ?? parseLevel(process.env.BLH_LOG_LEVEL);
  logDir = path.join(workdir, ".blh", "logs");
  mkdirSync(logDir, { recursive: true });
}

export function resetLogger(): void {
  currentLevel = "info";
  logDir = null;
}

function writeEntryToFile(entry: LogEntry): void {
  if (logDir === null) return;
  try {
    const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
    appendFileSync(filePath, formatFile(entry), "utf8");
  } catch {
    // 写文件失败降级：静默忽略，避免日志写入本身成为崩溃源
  }
}

export function appendRawEntry(entry: LogEntry): void {
  writeEntryToFile(entry);
}

function terminalSink(): LogSink {
  return { write: (entry) => process.stderr.write(formatTerminal(entry) + "\n") };
}

function fileSink(): LogSink {
  return { write: writeEntryToFile };
}

export function createLogger(name: string): Logger {
  return new CoreLogger(name, [terminalSink(), fileSink()], () => currentLevel);
}
