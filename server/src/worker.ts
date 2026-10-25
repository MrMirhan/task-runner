import { DurableObject } from "cloudflare:workers";
import type { Db, SqlValue } from "../../src/core/db.ts";
import { handleRulesApi, isRulesPath } from "../../src/core/rules-api.ts";
import { RulesStore } from "../../src/core/rules.ts";

const VERSION = "1.0.0";
const MAX_BODY = 64 * 1024;

interface Env {
  RULES: DurableObjectNamespace<RulesDO>;
  ASSETS: Fetcher;
  /** Secret: the one key that unlocks the API and the web page. */
  TASK_RUNNER_KEY: string;
}

/** The core's SQL surface on top of Durable Object SQLite. */
function durableDb(storage: DurableObjectStorage): Db {
  const rows = <T>(sql: string, params: SqlValue[]): T[] => storage.sql.exec(sql, ...params).toArray() as T[];
  return {
    all: <T>(sql: string, ...params: SqlValue[]) => rows<T>(sql, params),
    get: <T>(sql: string, ...params: SqlValue[]) => rows<T>(sql, params)[0],
    run: (sql: string, ...params: SqlValue[]) => void rows(sql, params),
    exec: (sql: string) => void storage.sql.exec(sql).toArray(),
    transaction: <T>(fn: () => T) => storage.transactionSync(fn),
  };
}

/** One Durable Object holds this deployment's rules: a single owner, a single key. */
export class RulesDO extends DurableObject<Env> {
  private readonly rules: RulesStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rules = new RulesStore(durableDb(ctx.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let body: unknown;
    if (request.method === "POST" || request.method === "PUT") {
      const raw = await request.text();
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
    }
    const out = handleRulesApi(this.rules, {
      method: request.method,
      path: url.pathname.replace(/^\/api/, ""),
      query: url.searchParams,
      body,
    });
    return json(out.body, out.status);
  }
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
}

async function sameKey(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  // Hash both so the comparison always runs over equal lengths in constant time.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return env.ASSETS.fetch(request);

    if (url.pathname === "/api/health") {
      return json({ ok: true, version: VERSION, mode: "remote", auth: "bearer", features: ["rules"] });
    }

    if (!env.TASK_RUNNER_KEY || env.TASK_RUNNER_KEY.length < 24) {
      return json({ error: "Server key missing or shorter than 24 characters. Set it with: wrangler secret put TASK_RUNNER_KEY" }, 500);
    }
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
    if (!(await sameKey(bearer, env.TASK_RUNNER_KEY))) return json({ error: "Unauthorized" }, 401);

    const path = url.pathname.replace(/^\/api/, "");
    if (!isRulesPath(path)) return json({ error: "This server only stores rules and devices." }, 404);
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return json({ error: "Request too large" }, 413);

    return env.RULES.get(env.RULES.idFromName("main")).fetch(request);
  },
} satisfies ExportedHandler<Env>;
