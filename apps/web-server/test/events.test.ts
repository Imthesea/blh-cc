import { describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/events.js";

describe("EventBus", () => {
  it("单个监听器抛异常不中断其它监听器", async () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(async () => {
      throw new Error("boom");
    });
    bus.subscribe(good);

    await expect(bus.emit({ type: "turn_end" })).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledWith({ type: "turn_end" });
  });
});
