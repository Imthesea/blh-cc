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
