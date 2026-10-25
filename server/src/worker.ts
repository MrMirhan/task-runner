import { DurableObject } from "cloudflare:workers";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { Db, SqlValue } from "../../src/core/db.ts";
import { RulesStore } from "../../src/core/rules.ts";
import { Store } from "../../src/core/store.ts";
import { bearerOf, health, isAppPath, json, routeApp, sameKey } from "../../src/http/app.ts";

interface Env {
  STORAGE_OBJECT: DurableObjectNamespace<TaskRunnerStorage>;
  ASSETS: Fetcher;
  /** Secret: the key that unlocks the MCP endpoint, the API and the web page. */
  TASK_RUNNER_KEY?: string;
  /** Which stored data that key opens. Servers upgraded from before 1.0 set it to their old tenant id. */
  TASK_RUNNER_TENANT?: string;
  /** Only on servers upgraded from before 1.0: the keys that were issued there keep working. */
  ADMIN_OBJECT?: DurableObjectNamespace<AdminStorage>;
}

/** The core's SQL surface on top of Durable Object SQLite. */
function durableDb(storage: DurableObjectStorage): Db {
  const rows = <T>(sql: string, params: SqlValue[]): T[] => storage.sql.exec(sql, ...params).toArray() as T[];
  let depth = 0;
  return {
    all: <T>(sql: string, ...params: SqlValue[]) => rows<T>(sql, params),
    get: <T>(sql: string, ...params: SqlValue[]) => rows<T>(sql, params)[0],
    run: (sql: string, ...params: SqlValue[]) => void rows(sql, params),
    exec: (sql: string) => void storage.sql.exec(sql).toArray(),
    // The store nests transactions; the outermost one is the real one.
    transaction: <T>(fn: () => T) => {
      if (depth > 0) return fn();
      depth++;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth--;
      }
    },
  };
}

/** One tenant's memory, tasks, time rows and rules. */
export class TaskRunnerStorage extends DurableObject<Env> {
  private readonly deps: { store: Store; rules: RulesStore; mcpOptions: { jsonSchemaValidator: CfWorkerJsonSchemaValidator } };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = durableDb(ctx.storage);
    // Opening the store runs the migrations, which also upgrade the tables written before 1.0.
    this.deps = { store: new Store(db), rules: new RulesStore(db), mcpOptions: { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() } };
  }

  async fetch(request: Request): Promise<Response> {
    return routeApp(this.deps, request);
  }
}

/** Before 1.0 the server issued one key per tenant. This keeps reading that table and nothing else. */
export class AdminStorage extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const { hash } = (await request.json()) as { hash?: string };
    const exists = this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").toArray().length > 0;
    if (!hash || !exists) return json({ tenant_id: null });
    const row = this.ctx.storage.sql
      .exec("SELECT id, tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL", hash)
      .toArray()[0];
    if (row) this.ctx.storage.sql.exec("UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?", row.id);
    return json({ tenant_id: row ? String(row.tenant_id) : null });
  }
}

/** The MCP session class from before 1.0. It is kept so its storage is not deleted; it serves nothing. */
export class TaskRunnerMCP extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return json({ error: "Gone. Connect to /mcp." }, 410);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function tenantFor(request: Request, env: Env): Promise<string | null> {
  const bearer = bearerOf(request);
  if (!bearer) return null;
  if (env.TASK_RUNNER_KEY && env.TASK_RUNNER_KEY.length >= 24 && (await sameKey(bearer, env.TASK_RUNNER_KEY))) {
    return env.TASK_RUNNER_TENANT || "main";
  }
  if (env.ADMIN_OBJECT) {
    const answer = await env.ADMIN_OBJECT.get(env.ADMIN_OBJECT.idFromName("admin-singleton")).fetch("https://admin/validate", {
      method: "POST",
      body: JSON.stringify({ hash: await sha256Hex(bearer) }),
    });
    return ((await answer.json()) as { tenant_id: string | null }).tenant_id;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!isAppPath(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/health") return health();

    if (!env.TASK_RUNNER_KEY && !env.ADMIN_OBJECT) {
      return json({ error: "No server key. Set one with: wrangler secret put TASK_RUNNER_KEY (24 characters or more)" }, 500);
    }
    const tenant = await tenantFor(request, env);
    if (!tenant) return json({ error: "Unauthorized" }, 401);
    return env.STORAGE_OBJECT.get(env.STORAGE_OBJECT.idFromName(tenant)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
