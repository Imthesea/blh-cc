import { describe, expect, it } from "vitest";
import { cronMatches, validateCron } from "../../src/jobs/cron.js";

describe("cronMatches", () => {
  it("matches every minute", () => {
    const moment = new Date(2026, 8, 14, 10, 30); // 2026-09-14 10:30 本地
    expect(cronMatches("* * * * *", moment)).toBe(true);
    expect(cronMatches("*/5 * * * *", moment)).toBe(true);
    expect(cronMatches("*/7 * * * *", moment)).toBe(false);
  });

  it("matches specific minute and hour", () => {
    expect(cronMatches("30 10 * * *", new Date(2026, 8, 14, 10, 30))).toBe(true);
    expect(cronMatches("30 10 * * *", new Date(2026, 8, 14, 10, 31))).toBe(false);
  });

  it("matches ranges and lists", () => {
    expect(cronMatches("0-30 10 * * *", new Date(2026, 8, 14, 10, 15))).toBe(true);
    expect(cronMatches("0,15,30 10 * * *", new Date(2026, 8, 14, 10, 15))).toBe(true);
    expect(cronMatches("0,15,30 10 * * *", new Date(2026, 8, 14, 10, 20))).toBe(false);
  });

  it("matches weekday", () => {
    const monday = new Date(2026, 7, 10, 9, 0); // 2026-08-10 周一,cron 周一=1
    expect(cronMatches("0 9 * * 1", monday)).toBe(true);
    expect(cronMatches("0 9 * * 2", monday)).toBe(false);
  });
});

describe("validateCron", () => {
  it("accepts valid expressions", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 9 * * 1-5")).toBeNull();
  });

  it("rejects wrong field count", () => {
    expect(validateCron("0 9 * *")).toContain("Expected 5 fields");
    expect(validateCron("0 9 * * * *")).toContain("Expected 5 fields");
  });

  it("rejects out of range values", () => {
    expect(validateCron("60 9 * * *")).not.toBeNull();
    expect(validateCron("0 24 * * *")).toContain("hour");
    expect(validateCron("0 9 0 * *")).not.toBeNull();
    expect(validateCron("0 9 * 13 *")).not.toBeNull();
  });

  it("rejects malformed fields", () => {
    expect(validateCron("x 9 * * *")).not.toBeNull();
    expect(validateCron("*/0 * * * *")).not.toBeNull();
    expect(validateCron("5-1 * * * *")).not.toBeNull();
  });
});
