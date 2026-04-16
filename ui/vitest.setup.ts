function createStorageMock() {
  const store = new Map<string, string>();

  return {
    getItem(key: string) {
      return store.get(String(key)) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    get length() {
      return store.size;
    },
  };
}

function hasStorageApi(value: unknown): value is Storage {
  return !!value
    && typeof (value as Storage).getItem === "function"
    && typeof (value as Storage).setItem === "function"
    && typeof (value as Storage).removeItem === "function"
    && typeof (value as Storage).clear === "function";
}

function installStorageMock(target: Record<string, unknown>, name: "localStorage" | "sessionStorage") {
  Object.defineProperty(target, name, {
    configurable: true,
    value: createStorageMock(),
  });
}

function ensureStorageApi(name: "localStorage" | "sessionStorage") {
  if (!hasStorageApi(globalThis[name])) {
    installStorageMock(globalThis as unknown as Record<string, unknown>, name);
  }

  if (typeof window !== "undefined" && !hasStorageApi(window[name])) {
    installStorageMock(window as unknown as Record<string, unknown>, name);
  }
}

ensureStorageApi("localStorage");
ensureStorageApi("sessionStorage");
