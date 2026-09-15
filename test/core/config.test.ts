import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("reads values from environment", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:8000/v1");
    vi.stubEnv("OPENAI_MODEL", "my-model");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig("/tmp/work");
    expect(config.apiKey).toBe("sk-test");
    expect(config.baseUrl).toBe("http://localhost:8000/v1");
    expect(config.model).toBe("my-model");
    expect(config.workdir).toBe("/tmp/work");
    expect(config.bashTimeout).toBe(120);
    expect(config.maxOutputChars).toBe(30000);
  });

  it("defaults model and baseUrl", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.baseUrl).toBeUndefined();
    expect(config.workdir).toBe(process.cwd());
  });

  it("exits when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { loadConfig } = await import("../../src/core/config.js");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfig()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith("OPENAI_API_KEY is not set");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
