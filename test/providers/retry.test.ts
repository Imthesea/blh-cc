import { describe, it, expect, vi } from "vitest";
import { retryDelay, isRetryable, withRetry } from "../../src/providers/retry.js";

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe("retryDelay", () => {
  it("doubles with attempt, capped at 32", () => {
    expect(retryDelay(0)).toBe(1);
    expect(retryDelay(1)).toBe(2);
    expect(retryDelay(5)).toBe(32);
    expect(retryDelay(10)).toBe(32);
  });
});

describe("isRetryable", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryable(httpError(429))).toBe(true);
    expect(isRetryable(httpError(500))).toBe(true);
    expect(isRetryable(httpError(503))).toBe(true);
  });
  it("does not retry other 4xx", () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(401))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });
  it("retries errors without status (network failures)", () => {
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries retryable errors until success", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValue("ok");
    const p = withRetry(fn);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws non-retryable errors immediately", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withRetry(fn)).rejects.toThrow("http 400");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(httpError(503));
    const p = withRetry(fn, 3);
    const assertion = expect(p).rejects.toThrow("http 503");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});
