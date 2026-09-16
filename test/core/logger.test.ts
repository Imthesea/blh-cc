import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  formatFile,
  formatTerminal,
  initLogger,
  resetLogger,
} from "../../src/core/logger.js";

let tmpDir: string;

function logFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `blh-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "logger-"));
  resetLogger();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetLogger();
  vi.restoreAllMocks();
});

describe("formatTerminal", () => {
  it("renders time, level, module, message, fields", () => {
    const line = formatTerminal({
      time: new Date("2026-09-16T08:03:22.000Z"),
      level: "info",
      module: "providers.openai",
      message: "chat request",
      fields: { model: "gpt-4o-mini", tools: 5 },
    });
    expect(line).toContain("[info]");
    expect(line).toContain("[providers.openai]");
    expect(line).toContain("chat request");
    expect(line).toContain("model=gpt-4o-mini");
    expect(line).toContain("tools=5");
  });
});

describe("formatFile", () => {
  it("renders a single JSON line", () => {
    const line = formatFile({
      time: new Date("2026-09-16T08:03:22.000Z"),
      level: "info",
      module: "core.loop",
      message: "turn",
      fields: {},
    });
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("core.loop");
    expect(parsed.msg).toBe("turn");
    expect(parsed.time).toBe("2026-09-16T08:03:22.000Z");
  });
});

describe("createLogger", () => {
  it("writes to file after initLogger", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("providers.openai");
    log.info("chat request", { model: "m" });
    const file = path.join(tmpDir, ".blh", "logs", logFileName());
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("chat request");
  });

  it("does not write file before initLogger", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    log.info("hello");
    expect(write).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, ".blh", "logs"))).toBe(false);
  });

  it("filters debug at default info level", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.debug("hidden");
    log.info("shown");
    const file = path.join(tmpDir, ".blh", "logs", logFileName());
    const content = readFileSync(file, "utf8");
    expect(content).toContain("shown");
    expect(content).not.toContain("hidden");
  });

  it("child appends name with a dot", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("core").child("loop");
    log.info("turn");
    expect(write.mock.calls[0]?.[0]).toContain("[core.loop]");
  });

  it("error attaches stack and message", () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    const err = new Error("boom");
    log.error("failed", {}, err);
    const file = path.join(tmpDir, ".blh", "logs", logFileName());
    const content = readFileSync(file, "utf8");
    expect(content).toContain("failed: boom");
    expect(content).toContain("stack");
  });
});
