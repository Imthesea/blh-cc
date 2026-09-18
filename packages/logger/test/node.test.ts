import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, initLogger, resetLogger } from "../src/node.js";
import { fileDate } from "../src/format.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "logger-"));
  resetLogger();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetLogger();
  vi.restoreAllMocks();
});

describe("node logger", () => {
  it("initLogger 后写文件", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("providers.openai");
    log.info("chat request", { model: "m" });
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("chat request");
  });

  it("未 initLogger 时只写 stderr 不写文件", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    log.info("hello");
    expect(write).toHaveBeenCalled();
    expect(existsSync(path.join(tmpDir, ".blh", "logs"))).toBe(false);
  });

  it("过滤 debug（默认 info 级别）", () => {
    initLogger(tmpDir, "info");
    const log = createLogger("x");
    log.debug("hidden");
    log.info("shown");
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("shown");
    expect(content).not.toContain("hidden");
  });

  it("child 拼接名字", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("core").child("loop");
    log.info("turn");
    expect(write.mock.calls[0]?.[0]).toContain("[core.loop]");
  });

  it("error 附带消息与堆栈", () => {
    initLogger(tmpDir, "error");
    const log = createLogger("x");
    log.error("failed", {}, new Error("boom"));
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("failed: boom");
    expect(content).toContain("stack");
  });

  it("写文件失败时不抛错", () => {
    initLogger(tmpDir, "info");
    // 把目标日志文件占位成目录，使 appendFileSync 抛出 EISDIR
    const file = path.join(tmpDir, ".blh", "logs", `blh-${fileDate(new Date())}.log`);
    mkdirSync(file, { recursive: true });
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createLogger("x");
    expect(() => log.info("hello")).not.toThrow();
    expect(write).toHaveBeenCalled();
  });
});
