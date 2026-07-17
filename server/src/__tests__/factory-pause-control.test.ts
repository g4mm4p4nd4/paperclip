import { describe, expect, it, vi } from "vitest";
import { createFactoryPauseControl } from "../services/factory-pause-control.js";

describe("factory pause control", () => {
  it("persists once before exposing the paused runtime posture", async () => {
    let release!: () => void;
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    const persistPause = vi.fn(() => persistence);
    const control = createFactoryPauseControl({ initiallyPaused: false, persistPause });
    const first = control.pause();
    const second = control.pause();
    expect(control.isPaused()).toBe(false);
    expect(persistPause).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(control.isPaused()).toBe(true);
    await control.pause();
    expect(persistPause).toHaveBeenCalledTimes(1);
  });

  it("remains unpaused when durable persistence fails", async () => {
    const control = createFactoryPauseControl({
      initiallyPaused: false,
      persistPause: async () => { throw new Error("disk unavailable"); },
    });
    await expect(control.pause()).rejects.toThrow("disk unavailable");
    expect(control.isPaused()).toBe(false);
  });
});
