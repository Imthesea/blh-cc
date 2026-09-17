import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

/** 日志级别，从低到高：debug < info < warn < error。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 日志的附加字段：任意键值对，比如 { event: "stop" }。 */
export interface LogFields {
  [key: string]: unknown;
}

/** 日志器的对外接口：提供四种级别，外加一个 child（生成子日志器）。 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields, error?: unknown): void;
  child(name: string): Logger;
}

/** 一条日志记录：时间、级别、模块名、正文、附加字段。 */
export interface LogEntry {
  time: Date;
  level: LogLevel;
  module: string;
  message: string;
  fields: LogFields;
}

/** 每个日志级别对应的数值，用于比较：低于当前级别的日志会被丢掉。 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 当前生效的日志级别（低于它的日志不输出）。 */
let currentLevel: LogLevel = "info";
/** 日志文件输出目录；为 null 表示不写文件。 */
let logDir: string | null = null;

/** 把字符串解析成日志级别；不是合法级别（或没传）就默认返回 "info"。 */
function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

/** 初始化日志：设定级别，并确定日志文件写到 workdir/.blh/logs 目录（不存在就创建）。 */
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

/** 把数字补成两位（比如 5 → "05"）。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 生成终端用的时间（时:分:秒）。 */
function terminalTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 生成日志文件名的日期部分（年-月-日）。 */
function fileDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把附加字段拼成 "key=value key=value" 的字符串；对象会被序列化成 JSON。 */
function formatFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const text =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${key}=${text}`;
    })
    .join(" ");
}

/** 把一条日志格式化成终端里的一行文本（带时间、级别、模块名）。 */
export function formatTerminal(entry: LogEntry): string {
  const suffix = formatFields(entry.fields);
  return `[${terminalTime(entry.time)}] [${entry.level}] [${entry.module}] ${entry.message}` +
    (suffix ? ` ${suffix}` : "");
}

/** 把一条日志格式化成写进文件的一行 JSON。 */
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

/** 日志器的具体实现。 */
class LoggerImpl implements Logger {
  constructor(private readonly name: string) {}

  /** 真正写一条日志：级别不够就跳过，否则同时输出到终端和日志文件。 */
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

  /** 写一条 error 日志；如果额外传了 error 对象，会把它的信息（和堆栈）一起带上。 */
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

  /** 生成一个子日志器：模块名是「父模块名.子名」，方便区分不同模块的日志。 */
  child(name: string): Logger {
    return new LoggerImpl(`${this.name}.${name}`);
  }
}

/** 创建一个日志器（按模块命名，供各模块调用）。 */
export function createLogger(name: string): Logger {
  return new LoggerImpl(name);
}
