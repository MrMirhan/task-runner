// The server key lives in sessionStorage by default and in localStorage when the person asks
// to stay signed in. A copy in memory keeps the page working when storage is blocked.
const STORAGE_KEY = "task-runner-key";

let current: string | null = null;
const listeners = new Set<() => void>();

function read(store: "sessionStorage" | "localStorage"): string | null {
  try {
    return window[store].getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remove(store: "sessionStorage" | "localStorage"): void {
  try {
    window[store].removeItem(STORAGE_KEY);
  } catch {
    // storage can be blocked; nothing to remove
  }
}

export function loadStoredKey(): string | null {
  current = read("sessionStorage") || read("localStorage") || null;
  return current;
}

export function getKey(): string | null {
  return current;
}

export function storeKey(key: string, keep: boolean): void {
  current = key;
  remove("sessionStorage");
  remove("localStorage");
  try {
    (keep ? window.localStorage : window.sessionStorage).setItem(STORAGE_KEY, key);
  } catch {
    // storage can be blocked; the key stays in memory for this page
  }
}

export function clearKey(): void {
  current = null;
  remove("sessionStorage");
  remove("localStorage");
}

/** Fires when the server rejects the key on a request that carried one. */
export function onUnauthorized(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyUnauthorized(): void {
  for (const l of listeners) l();
}
