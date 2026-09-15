import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalCwd = process.cwd();

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

describe("loadConfig .env", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "config-env-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads values from .env", async () => {
    const savedApiKey = process.env.OPENAI_API_KEY;
    const savedBaseUrl = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    try {
      writeFileSync(
        path.join(tmpDir, ".env"),
        "OPENAI_API_KEY=sk-from-dotenv\nOPENAI_BASE_URL=http://dotenv:1/v1\n",
      );
      const { loadConfig } = await import("../../src/core/config.js");
      const config = loadConfig();
      expect(config.apiKey).toBe("sk-from-dotenv");
      expect(config.baseUrl).toBe("http://dotenv:1/v1");
    } finally {
      if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedApiKey;
      if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = savedBaseUrl;
    }
  });

  it("env vars take precedence over .env", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    writeFileSync(path.join(tmpDir, ".env"), "OPENAI_API_KEY=sk-from-dotenv\n");
    const { loadConfig } = await import("../../src/core/config.js");
    const config = loadConfig();
    expect(config.apiKey).toBe("sk-from-env");
  });
});
