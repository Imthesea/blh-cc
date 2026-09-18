import { CoreLogger, formatTerminal } from "./format.js";
import type { Logger, LogEntry, LogLevel, LogSink } from "./types.js";

export type { LogLevel, LogFields, Logger, LogEntry, LogSink } from "./types.js";
export { formatTerminal, formatFile } from "./format.js";

let currentLevel: LogLevel = "info";
let remoteTransport: ((entry: LogEntry) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setRemoteTransport(fn: (entry: LogEntry) => void): void {
  remoteTransport = fn;
}

export function resetRemoteTransport(): void {
  remoteTransport = null;
}

function consoleSink(): LogSink {
  return {
    write: (entry) => {
      const line = formatTerminal(entry);
      switch (entry.level) {
        case "debug":
          console.debug(line);
          break;
        case "info":
          console.info(line);
          break;
        case "warn":
          console.warn(line);
          break;
        case "error":
          console.error(line);
          break;
      }
    },
  };
}

function remoteSink(): LogSink {
  return { write: (entry) => remoteTransport?.(entry) };
}

export function createLogger(name: string): Logger {
  return new CoreLogger(name, [consoleSink(), remoteSink()], () => currentLevel);
}
