import { describe, expect, it } from "vitest";
import { extractJsonArray, messageText } from "../../src/memory/text.js";

describe("memory text helpers", () => {
  it("messageText str and null", () => {
    expect(messageText({ role: "user", content: "hi" })).toBe("hi");
    expect(messageText({ role: "assistant", content: null })).toBe("");
  });

  it("extractJsonArray simple", () => {
    expect(extractJsonArray("[0, 2]")).toEqual([0, 2]);
    expect(extractJsonArray("here: [1, 3] and more")).toEqual([1, 3]);
  });

  it("extractJsonArray malformed", () => {
    expect(extractJsonArray("no array")).toEqual([]);
    expect(extractJsonArray("[unclosed")).toEqual([]);
  });

  it("extractJsonArray ignores non-list", () => {
    expect(extractJsonArray('{"a": 1}')).toEqual([]);
  });
});
