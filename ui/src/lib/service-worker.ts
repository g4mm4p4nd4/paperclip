export interface ServiceWorkerRegistrationLike {
  unregister: () => Promise<boolean> | boolean;
}

export interface ServiceWorkerContainerLike {
  getRegistrations: () => Promise<ServiceWorkerRegistrationLike[]>;
  register: (scriptUrl: string) => Promise<unknown> | unknown;
}

export interface CacheStorageLike {
  keys: () => Promise<string[]>;
  delete: (key: string) => Promise<boolean> | boolean;
}

export interface ReconcileServiceWorkerStateOptions {
  isDev: boolean;
  serviceWorker?: ServiceWorkerContainerLike | null;
  cacheStorage?: CacheStorageLike | null;
}

export interface ReconcileServiceWorkerStateResult {
  mode: "unsupported" | "dev_cleanup" | "registered";
  unregisteredCount: number;
  clearedCacheCount: number;
}

export async function reconcileServiceWorkerState(
  options: ReconcileServiceWorkerStateOptions,
): Promise<ReconcileServiceWorkerStateResult> {
  const { isDev, serviceWorker, cacheStorage } = options;

  if (!serviceWorker) {
    return {
      mode: "unsupported",
      unregisteredCount: 0,
      clearedCacheCount: 0,
    };
  }

  if (isDev) {
    const registrations = await serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));

    const cacheKeys = cacheStorage ? await cacheStorage.keys() : [];
    await Promise.all(cacheKeys.map((key) => cacheStorage!.delete(key)));

    return {
      mode: "dev_cleanup",
      unregisteredCount: registrations.length,
      clearedCacheCount: cacheKeys.length,
    };
  }

  await serviceWorker.register("/sw.js");
  return {
    mode: "registered",
    unregisteredCount: 0,
    clearedCacheCount: 0,
  };
}
