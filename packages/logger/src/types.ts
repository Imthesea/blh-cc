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

export interface LogSink {
  write(entry: LogEntry): void;
}
