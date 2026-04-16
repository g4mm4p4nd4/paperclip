import { describe, expect, it, vi } from "vitest";
import { reconcileServiceWorkerState } from "./service-worker";

describe("reconcileServiceWorkerState", () => {
  it("unregisters existing service workers and clears caches in dev", async () => {
    const unregisterA = vi.fn().mockResolvedValue(true);
    const unregisterB = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([
      { unregister: unregisterA },
      { unregister: unregisterB },
    ]);
    const register = vi.fn();
    const keys = vi.fn().mockResolvedValue(["paperclip-v1", "paperclip-v2"]);
    const deleteCache = vi.fn().mockResolvedValue(true);

    const result = await reconcileServiceWorkerState({
      isDev: true,
      serviceWorker: { getRegistrations, register },
      cacheStorage: { keys, delete: deleteCache },
    });

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregisterA).toHaveBeenCalledTimes(1);
    expect(unregisterB).toHaveBeenCalledTimes(1);
    expect(keys).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenNthCalledWith(1, "paperclip-v1");
    expect(deleteCache).toHaveBeenNthCalledWith(2, "paperclip-v2");
    expect(register).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "dev_cleanup",
      unregisteredCount: 2,
      clearedCacheCount: 2,
    });
  });

  it("registers the service worker outside dev", async () => {
    const register = vi.fn().mockResolvedValue({});
    const getRegistrations = vi.fn();

    const result = await reconcileServiceWorkerState({
      isDev: false,
      serviceWorker: { getRegistrations, register },
    });

    expect(register).toHaveBeenCalledWith("/sw.js");
    expect(getRegistrations).not.toHaveBeenCalled();
    expect(result).toEqual({
      mode: "registered",
      unregisteredCount: 0,
      clearedCacheCount: 0,
    });
  });

  it("no-ops when service workers are unavailable", async () => {
    const result = await reconcileServiceWorkerState({
      isDev: true,
      serviceWorker: null,
      cacheStorage: null,
    });

    expect(result).toEqual({
      mode: "unsupported",
      unregisteredCount: 0,
      clearedCacheCount: 0,
    });
  });
});
