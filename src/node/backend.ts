import type { StoreApi } from "../core/api.ts";
import { StoreError, type StoreErrorCode } from "../core/errors.ts";
import { RulesStore } from "../core/rules.ts";
import { Store } from "../core/store.ts";
import { LocalRulesClient, loadRemote, RemoteRulesClient, type RemoteConfig, type RulesClient } from "./remote.ts";
import { defaultDbPath, openDb, type NodeDb } from "./sqlite.ts";

/**
 * Where memory lives: this machine's SQLite file, or the Task Runner server this machine signed in to.
 * Everything above this line (CLI, hook, MCP tools, panel) is the same in both.
 */
export interface Backend {
  mode: "local" | "remote";
  store: StoreApi;
  rules: RulesClient;
  /** A human description of where the data is. */
  location: string;
  /** The local database, also in remote mode (device files, caches). */
  db: NodeDb;
  /** Only in local mode: the synchronous store, for code that needs it (the dashboard server). */
  local: Store | null;
  close(): void;
}

export function remoteStore(config: RemoteConfig, timeoutMs = 20000): StoreApi {
  const call = async (method: string, args: unknown[]) => {
    const response = await fetch(`${config.url}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: "store", method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json().catch(() => ({ error: `Server answered ${response.status}`, code: "internal" }))) as
      | { result: unknown }
      | { error: string; code: string };
    if ("error" in data) {
      const code = (["invalid", "not_found", "conflict"].includes(data.code) ? data.code : null) as StoreErrorCode | null;
      throw code ? new StoreError(code, data.error) : new Error(data.error);
    }
    return data.result;
  };
  return new Proxy({} as StoreApi, {
    // "then" stays undefined so the proxy is never mistaken for a promise.
    get: (_, method) => (typeof method === "string" && method !== "then" ? (...args: unknown[]) => call(method, args) : undefined),
  });
}

export function openBackend(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Backend {
  const env = options.env ?? process.env;
  const db = openDb(defaultDbPath(env));
  const remote = loadRemote(env);
  if (remote) {
    return {
      mode: "remote",
      store: remoteStore(remote, options.timeoutMs),
      rules: new RemoteRulesClient(remote, options.timeoutMs),
      location: `server ${remote.url}`,
      db,
      local: null,
      close: () => db.close(),
    };
  }
  const store = new Store(db);
  return {
    mode: "local",
    store,
    rules: new LocalRulesClient(new RulesStore(db)),
    location: defaultDbPath(env),
    db,
    local: store,
    close: () => db.close(),
  };
}
