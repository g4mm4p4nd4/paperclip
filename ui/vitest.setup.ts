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

function ensureStorageApi(name: "localStorage" | "sessionStorage") {
  const current = globalThis[name] as Storage | undefined;
  if (current && typeof current.clear === "function") {
    return;
  }

  Object.defineProperty(globalThis, name, {
    value: createStorageMock(),
    configurable: true,
  });
}

ensureStorageApi("localStorage");
ensureStorageApi("sessionStorage");
