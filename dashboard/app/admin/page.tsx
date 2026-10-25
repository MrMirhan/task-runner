"use client";

import { useCallback, useEffect, useId, useState } from "react";
import ThemeToggle from "../components/ThemeToggle";

// The admin account is separate from the access keys: it signs in with a username and password,
// gets a short-lived session token and manages the keys. The token stays in this tab only.
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/+$/, "");
const TOKEN_KEY = "task-runner-admin";

interface KeyRow {
  id: string;
  key_prefix: string;
  tenant_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface Totals {
  projects: number;
  entities: number;
  facts: number;
  notes: number;
  tasks: number;
  preferences: number;
  last_change: number | null;
}

interface Tenant {
  id: string;
  keys: number;
  labels: string[];
  server_key: boolean;
  last_used_at: number | null;
  totals: Totals | null;
}

interface Stats {
  keys: { total: number; active: number; revoked: number };
  tenants: Tenant[];
}

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage can be blocked; the token then lives as long as the page
  }
}

class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/admin${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new AdminError(0, "Cannot reach the server.");
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new AdminError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

const when = (seconds: number | null) => {
  if (!seconds) return "never";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(seconds * 1000).toISOString().slice(0, 10);
};

const tenantName = (t: Pick<Tenant, "id" | "labels" | "server_key">) =>
  t.labels.length ? `${t.labels.slice(0, 3).join(", ")}${t.labels.length > 3 ? ` +${t.labels.length - 3}` : ""}` : t.server_key ? "Server key" : t.id;

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setToken(readToken());
    setChecked(true);
  }, []);

  const signOut = useCallback(() => {
    writeToken(null);
    setToken(null);
  }, []);

  if (!checked) return null;
  return token ? <Console token={token} onSignOut={signOut} /> : <SignIn onToken={(t) => (writeToken(t), setToken(t))} />;
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="whitespace-nowrap text-base font-bold">Task Runner</h1>
        <span className="pill">Admin</span>
        <div className="ml-auto flex items-center gap-2">
          <a href="/" className="btn">
            Dashboard
          </a>
          <ThemeToggle />
          {right}
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

function SignIn({ onToken }: { onToken: (token: string) => void }) {
  const id = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await call<{ token: string }>(null, "POST", "/login", { username: username.trim(), password });
      onToken(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="flex flex-1 items-center justify-center p-4">
        <form onSubmit={submit} method="post" className="card w-full max-w-sm space-y-4 p-5">
          <div>
            <h2 className="text-base font-semibold">Admin sign in</h2>
            <p className="mt-1 text-sm text-muted">Manage the access keys of this server.</p>
          </div>
          <div>
            <label htmlFor={`${id}-user`} className="mb-1 block text-sm font-medium">
              Username
            </label>
            <input id={`${id}-user`} name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} autoFocus required className="field" />
          </div>
          <div>
            <label htmlFor={`${id}-pass`} className="mb-1 block text-sm font-medium">
              Password
            </label>
            <input id={`${id}-pass`} name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} className="field" />
          </div>
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-bad">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || !username.trim() || !password} className="btn btn-primary w-full justify-center">
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    </Shell>
  );
}

function Console({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ raw_key: string; label: string; tenant_id: string } | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([call<{ keys: KeyRow[] }>(token, "GET", "/keys"), call<Stats>(token, "GET", "/stats")])
      .then(([k, s]) => {
        if (!live) return;
        setKeys(k.keys);
        setStats(s);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof AdminError && e.status === 401) onSignOut();
        else setError(e instanceof Error ? e.message : "Cannot load");
      });
    return () => {
      live = false;
    };
  }, [token, reload, onSignOut]);

  const tenants = stats?.tenants ?? [];
  const byTenant = new Map(tenants.map((t) => [t.id, t]));

  async function revoke(row: KeyRow) {
    if (!window.confirm(`Revoke "${row.label}" (${row.key_prefix})? Every machine using it loses access at once.`)) return;
    try {
      await call(token, "DELETE", `/keys/${row.id}`);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    }
  }

  const totalsOf = (t: Tenant | undefined) => t?.totals;
  const mainTenant = tenants[0];

  return (
    <Shell
      right={
        <>
          <button type="button" onClick={() => setReload((n) => n + 1)} className="btn">
            Refresh
          </button>
          <button type="button" onClick={onSignOut} className="btn">
            Sign out
          </button>
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Active keys" value={stats ? stats.keys.active : "—"} tone="text-ok" />
          <Stat label="Revoked keys" value={stats ? stats.keys.revoked : "—"} tone="text-muted" />
          <Stat label="Tenants" value={stats ? tenants.length : "—"} tone="text-info" />
          <Stat
            label="Busiest tenant"
            value={totalsOf(mainTenant) ? `${totalsOf(mainTenant)!.entities} entities` : "—"}
            note={mainTenant ? `${totalsOf(mainTenant)?.notes ?? 0} notes · ${totalsOf(mainTenant)?.projects ?? 0} projects` : undefined}
            tone="text-warn"
          />
        </dl>

        {created && <NewKey created={created} tenant={byTenant.get(created.tenant_id)} onDone={() => setCreated(null)} />}

        <CreateKey token={token} tenants={tenants} onCreated={(k) => (setCreated(k), setReload((n) => n + 1))} onError={setError} />

        <section className="card overflow-hidden">
          <h2 className="section-title border-b border-line px-4 py-3">Tenants</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Tenant</th>
                  <th className="px-4 py-2 font-medium">Keys</th>
                  <th className="px-4 py-2 font-medium">Projects</th>
                  <th className="px-4 py-2 font-medium">Entities</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id} className="border-t border-line">
                    <td className="px-4 py-2">
                      <div className="font-medium">{tenantName(t)}</div>
                      <div className="font-mono text-xs text-muted">{t.id}</div>
                    </td>
                    <td className="px-4 py-2">{t.keys}</td>
                    <td className="px-4 py-2">{t.totals?.projects ?? "—"}</td>
                    <td className="px-4 py-2">{t.totals?.entities ?? "—"}</td>
                    <td className="px-4 py-2">{t.totals?.notes ?? "—"}</td>
                    <td className="px-4 py-2 text-muted">{when(t.last_used_at)}</td>
                  </tr>
                ))}
                {stats && tenants.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted">
                      No tenants yet. Create a key below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card overflow-hidden">
          <h2 className="section-title border-b border-line px-4 py-3">Keys</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Opens</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(keys ?? []).map((k) => {
                  const t = byTenant.get(k.tenant_id);
                  return (
                    <tr key={k.id} className={`border-t border-line ${k.revoked_at ? "opacity-50" : ""}`}>
                      <td className="px-4 py-2 font-medium">{k.label}</td>
                      <td className="px-4 py-2 font-mono text-xs">{k.key_prefix}</td>
                      <td className="px-4 py-2">
                        <span className="text-sm">{t ? tenantName(t) : k.tenant_id}</span>
                      </td>
                      <td className="px-4 py-2 text-muted">{when(k.created_at)}</td>
                      <td className="px-4 py-2 text-muted">{when(k.last_used_at)}</td>
                      <td className="px-4 py-2 text-right">
                        {k.revoked_at ? (
                          <span className="status text-muted">Revoked {when(k.revoked_at)}</span>
                        ) : (
                          <button type="button" onClick={() => revoke(k)} className="btn btn-sm btn-danger">
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {keys && keys.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-muted">
                      No keys yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </Shell>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: string; tone: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 text-2xl font-bold ${tone}`}>{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-muted">{note}</dd>}
    </div>
  );
}

function CreateKey({
  token,
  tenants,
  onCreated,
  onError,
}: {
  token: string;
  tenants: Tenant[];
  onCreated: (k: { raw_key: string; label: string; tenant_id: string }) => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  const [label, setLabel] = useState("");
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Most keys are a new device for the same person, so the busiest tenant is the default.
  useEffect(() => {
    if (!target && tenants[0]) setTarget(tenants[0].id);
  }, [tenants, target]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { key } = await call<{ key: { raw_key: string; label: string; tenant_id: string } }>(token, "POST", "/keys", {
        label: label.trim(),
        tenant: target === "new" ? null : target,
      });
      setLabel("");
      onCreated(key);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create the key");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card flex flex-col gap-3 p-4 md:flex-row md:items-end">
      <div className="flex-1">
        <label htmlFor={`${id}-label`} className="mb-1 block text-sm font-medium">
          New key for
        </label>
        <input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="laptop, CI, a friend…" maxLength={80} className="field" />
      </div>
      <div className="flex-1">
        <label htmlFor={`${id}-target`} className="mb-1 block text-sm font-medium">
          Opens
        </label>
        <select id={`${id}-target`} value={target} onChange={(e) => setTarget(e.target.value)} className="field">
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {tenantName(t)} — {t.totals ? `${t.totals.entities} entities, ${t.totals.notes} notes` : t.id}
            </option>
          ))}
          <option value="new">A new empty tenant</option>
        </select>
      </div>
      <button type="submit" disabled={busy || !label.trim()} className="btn btn-primary justify-center">
        {busy ? "Creating…" : "Create key"}
      </button>
    </form>
  );
}

function NewKey({ created, tenant, onDone }: { created: { raw_key: string; label: string; tenant_id: string }; tenant?: Tenant; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section role="status" className="card space-y-3 border-ok p-4">
      <div>
        <h2 className="text-base font-semibold">Key created for {created.label}</h2>
        <p className="text-sm text-muted">
          It opens {tenant ? tenantName(tenant) : "a new empty tenant"}. Copy it now: it is shown only once.
        </p>
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <input readOnly value={created.raw_key} onFocus={(e) => e.currentTarget.select()} aria-label="New key" className="field flex-1 font-mono text-xs" />
        <button
          type="button"
          className="btn btn-primary justify-center"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(created.raw_key);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={onDone} className="btn justify-center">
          Done
        </button>
      </div>
      <p className="text-xs text-muted">
        On a machine: <code className="font-mono">task-runner-mcp login {typeof window === "undefined" ? "" : window.location.origin}</code>, then paste the key.
      </p>
    </section>
  );
}
