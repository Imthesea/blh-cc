import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLogger,
  resetRemoteTransport,
  setLogLevel,
  setRemoteTransport,
} from "../src/browser.js";

afterEach(() => {
  resetRemoteTransport();
  vi.restoreAllMocks();
});

describe("browser logger", () => {
  it("默认写 console（info 级别用 console.info）", () => {
    setLogLevel("info");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createLogger("web.app");
    log.info("hello");
    expect(info).toHaveBeenCalled();
  });

  it("过滤 debug（info 级别）", () => {
    setLogLevel("info");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("web.app");
    log.debug("hidden");
    expect(debug).not.toHaveBeenCalled();
  });

  it("setRemoteTransport 后转发条目", () => {
    setLogLevel("info");
    const remote = vi.fn();
    setRemoteTransport(remote);
    const log = createLogger("web.app");
    log.info("hello", { a: 1 });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(remote.mock.calls[0]?.[0]).toMatchObject({ module: "web.app", message: "hello" });
  });
});
