import { describe, expect, it } from "vitest";
import { formatFile, formatTerminal } from "../src/format.js";

describe("formatTerminal", () => {
  it("渲染时间、级别、模块、消息、字段", () => {
    const line = formatTerminal({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web-server.http",
      message: "chat request",
      fields: { model: "gpt-4o-mini", tools: 5 },
    });
    expect(line).toContain("[info]");
    expect(line).toContain("[web-server.http]");
    expect(line).toContain("chat request");
    expect(line).toContain("model=gpt-4o-mini");
    expect(line).toContain("tools=5");
  });

  it("时间含毫秒", () => {
    const time = new Date();
    time.setHours(8, 3, 22, 123);
    const line = formatTerminal({
      time,
      level: "info",
      module: "x",
      message: "m",
      fields: {},
    });
    expect(line).toContain("08:03:22.123");
  });

  it("含空白的字段值加引号", () => {
    const line = formatTerminal({
      time: new Date(),
      level: "info",
      module: "x",
      message: "m",
      fields: { path: "a b" },
    });
    expect(line).toContain('path="a b"');
  });
});

describe("formatFile", () => {
  it("渲染单行 JSON", () => {
    const line = formatFile({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "web.app",
      message: "turn",
      fields: {},
    });
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.module).toBe("web.app");
    expect(parsed.msg).toBe("turn");
    expect(parsed.time).toBe("2026-09-18T08:03:22.000Z");
  });
});

it("循环引用字段不抛错", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() =>
    formatTerminal({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "x",
      message: "m",
      fields: { circular },
    }),
  ).not.toThrow();
  expect(() =>
    formatFile({
      time: new Date("2026-09-18T08:03:22.000Z"),
      level: "info",
      module: "x",
      message: "m",
      fields: { circular },
    }),
  ).not.toThrow();
});
