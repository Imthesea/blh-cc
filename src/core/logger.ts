import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
  child(name: string): Logger;
}

export interface LogEntry {
  time: Date;
  level: LogLevel;
  module: string;
  message: string;
  fields: LogFields;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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

/** 仅供测试重置模块级状态 */
export function resetLogger(): void {
  currentLevel = "info";
  logDir = null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function terminalTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const text =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join(" ");
}

export function formatTerminal(entry: LogEntry): string {
  const suffix = formatFields(entry.fields);
  return `[${terminalTime(entry.time)}] [${entry.level}] [${entry.module}] ${entry.message}` +
    (suffix ? ` ${suffix}` : "");
}

export function formatFile(entry: LogEntry): string {
  return (
    JSON.stringify({
      time: entry.time.toISOString(),
      level: entry.level,
      module: entry.module,
      msg: entry.message,
      fields: entry.fields,
    }) + "\n"
  );
}

class LoggerImpl implements Logger {
  constructor(private readonly name: string) {}

  private write(level: LogLevel, message: string, fields: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
    const entry: LogEntry = {
      time: new Date(),
      level,
      module: this.name,
      message,
      fields,
    };
    process.stderr.write(formatTerminal(entry) + "\n");
    if (logDir !== null) {
      const filePath = path.join(logDir, `blh-${fileDate(entry.time)}.log`);
      appendFileSync(filePath, formatFile(entry), "utf8");
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields ?? {});
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields ?? {});
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields ?? {});
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    const merged: LogFields = { ...(fields ?? {}) };
    let finalMessage = message;
    if (error !== undefined) {
      if (error instanceof Error) {
        finalMessage = `${message}: ${error.message}`;
        if (error.stack !== undefined) merged.stack = error.stack;
      } else {
        finalMessage = `${message}: ${String(error)}`;
      }
    }
    this.write("error", finalMessage, merged);
  }

  child(name: string): Logger {
    return new LoggerImpl(`${this.name}.${name}`);
  }
}

export function createLogger(name: string): Logger {
  return new LoggerImpl(name);
}
