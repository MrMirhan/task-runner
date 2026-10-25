import { DurableObject } from "cloudflare:workers";
import { json, sameKey } from "../../src/http/app.ts";

/**
 * The admin side: one static account (ADMIN_USERNAME, ADMIN_PASSWORD_HASH as `saltHex:hashHex` of
 * PBKDF2-SHA256 with 100000 rounds, JWT_SECRET) that issues and revokes access keys. A key opens one
 * tenant: an existing one, so several keys share the same data, or a new empty one.
 */
export interface AdminEnv {
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
  JWT_SECRET?: string;
  TASK_RUNNER_KEY?: string;
  TASK_RUNNER_TENANT?: string;
}

const PBKDF2_ROUNDS = 100_000;
const SESSION_SECONDS = 12 * 3600;

const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array((s.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function passwordMatches(stored: string, attempt: string): Promise<boolean> {
  const [salt, expected] = stored.trim().split(":");
  if (!salt || !expected) return false;
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(attempt), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(salt), iterations: PBKDF2_ROUNDS }, material, 256);
  return sameKey(hex(bits), expected);
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}

async function signSession(secret: string, user: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: user, role: "admin", iat: now, exp: now + SESSION_SECONDS }))}`;
  return `${body}.${await hmac(secret, body)}`;
}

async function sessionValid(secret: string, token: string): Promise<boolean> {
  const [head, payload, sig] = token.split(".");
  if (!head || !payload || !sig) return false;
  if (!(await sameKey(await hmac(secret, `${head}.${payload}`), sig))) return false;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { role?: string; exp?: number };
    return claims.role === "admin" && typeof claims.exp === "number" && claims.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/** Issued keys. Before 1.1 a tenant could hold one key only; the table is rebuilt without that limit. */
export class AdminStorage extends DurableObject<AdminEnv> {
  private ready = false;

  private ensure(): void {
    if (this.ready) return;
    const sql = this.ctx.storage.sql;
    const table = sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'").toArray()[0]?.sql as string | undefined;
    const create = (name: string) => `CREATE TABLE ${name} (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      last_used_at INTEGER,
      revoked_at INTEGER
    )`;
    if (!table) {
      sql.exec(create("api_keys"));
    } else if (/tenant_id TEXT NOT NULL UNIQUE/i.test(table)) {
      this.ctx.storage.transactionSync(() => {
        sql.exec(create("api_keys_v2"));
        sql.exec(`INSERT INTO api_keys_v2 (id, key_hash, key_prefix, tenant_id, label, created_at, last_used_at, revoked_at)
                  SELECT id, key_hash, key_prefix, tenant_id, label, created_at, last_used_at, revoked_at FROM api_keys`);
        sql.exec("DROP TABLE api_keys");
        sql.exec("ALTER TABLE api_keys_v2 RENAME TO api_keys");
      });
    }
    sql.exec("CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)");
    this.ready = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensure();
    const sql = this.ctx.storage.sql;
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};

    if (url.pathname === "/validate") {
      const hash = typeof body.hash === "string" ? body.hash : "";
      const row = sql.exec("SELECT id, tenant_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL", hash).toArray()[0];
      if (row) sql.exec("UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?", row.id);
      return json({ tenant_id: row ? String(row.tenant_id) : null });
    }
    if (url.pathname === "/keys" && request.method === "GET") {
      return json({
        keys: sql
          .exec("SELECT id, key_prefix, tenant_id, label, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC")
          .toArray(),
      });
    }
    if (url.pathname === "/keys" && request.method === "POST") {
      const label = (typeof body.label === "string" ? body.label.trim() : "").slice(0, 80) || "Unnamed key";
      const tenant = typeof body.tenant === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(body.tenant) ? body.tenant : `tenant-${crypto.randomUUID().slice(0, 12)}`;
      const raw = `ctr_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
      const id = `key-${crypto.randomUUID().slice(0, 8)}`;
      sql.exec(
        "INSERT INTO api_keys (id, key_hash, key_prefix, tenant_id, label) VALUES (?, ?, ?, ?, ?)",
        id, await sha256Hex(raw), `${raw.slice(0, 12)}…`, tenant, label,
      );
      return json({ key: { id, raw_key: raw, tenant_id: tenant, label } });
    }
    const revoke = /^\/keys\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (revoke && request.method === "DELETE") {
      const found = sql.exec("SELECT id FROM api_keys WHERE id = ? AND revoked_at IS NULL", revoke[1]).toArray().length > 0;
      if (!found) return json({ error: "No active key with that id" }, 404);
      sql.exec("UPDATE api_keys SET revoked_at = unixepoch() WHERE id = ?", revoke[1]);
      return json({ revoked: revoke[1] });
    }
    return json({ error: "Not found" }, 404);
  }
}

interface AdminDeps {
  env: AdminEnv;
  admin: DurableObjectStub<AdminStorage> | null;
  /** Row counts of one tenant's database. */
  tenantTotals: (tenant: string) => Promise<unknown>;
}

export async function handleAdmin(request: Request, deps: AdminDeps): Promise<Response> {
  const { env, admin } = deps;
  const path = new URL(request.url).pathname.replace(/^\/api\/admin/, "") || "/";
  if (!admin || !env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.JWT_SECRET) {
    return json({ error: "The admin account is not set up on this server. See server/README.md." }, 404);
  }

  if (path === "/login" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
    const ok =
      typeof body.username === "string" &&
      typeof body.password === "string" &&
      (await sameKey(body.username, env.ADMIN_USERNAME.trim())) &&
      (await passwordMatches(env.ADMIN_PASSWORD_HASH, body.password));
    if (!ok) return json({ error: "Wrong username or password" }, 401);
    return json({ token: await signSession(env.JWT_SECRET.trim(), body.username!), expires_in: SESSION_SECONDS });
  }

  const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
  if (!(await sessionValid(env.JWT_SECRET.trim(), token))) return json({ error: "Sign in as admin again" }, 401);

  const keys = async () =>
    ((await (await admin.fetch("https://admin/keys")).json()) as {
      keys: Array<{ id: string; key_prefix: string; tenant_id: string; label: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>;
    }).keys;

  if (path === "/keys" && request.method === "GET") return json({ keys: await keys() });
  if (path === "/keys" && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { label?: string; tenant?: string | null };
    return admin.fetch("https://admin/keys", { method: "POST", body: JSON.stringify({ label: body.label, tenant: body.tenant ?? null }) });
  }
  const revoke = /^\/keys\/([A-Za-z0-9_-]+)$/.exec(path);
  if (revoke && request.method === "DELETE") return admin.fetch(`https://admin/keys/${revoke[1]}`, { method: "DELETE" });

  if (path === "/stats" && request.method === "GET") {
    const all = await keys();
    const ids = new Set(all.map((k) => k.tenant_id));
    if (env.TASK_RUNNER_KEY) ids.add(env.TASK_RUNNER_TENANT || "main");
    const tenants = await Promise.all(
      [...ids].map(async (id) => {
        const mine = all.filter((k) => k.tenant_id === id);
        return {
          id,
          keys: mine.filter((k) => k.revoked_at === null).length,
          labels: mine.filter((k) => k.revoked_at === null).map((k) => k.label),
          server_key: env.TASK_RUNNER_KEY ? id === (env.TASK_RUNNER_TENANT || "main") : false,
          last_used_at: Math.max(0, ...mine.map((k) => k.last_used_at ?? 0)) || null,
          totals: await deps.tenantTotals(id).catch(() => null),
        };
      }),
    );
    tenants.sort((a, b) => (b.last_used_at ?? 0) - (a.last_used_at ?? 0));
    return json({
      keys: { total: all.length, active: all.filter((k) => k.revoked_at === null).length, revoked: all.filter((k) => k.revoked_at !== null).length },
      tenants,
    });
  }
  return json({ error: "Not found" }, 404);
}
