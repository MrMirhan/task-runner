import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Db } from "../core/db.ts";
import { RulesStore, type Proposal, type ResolvedRules, type RuleContext, type RuleDoc, type RuleKey } from "../core/rules.ts";

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TASK_RUNNER_HOME || join(homedir(), ".task-runner");
}

// ─── Remote connection ────────────────────────────────────

export interface RemoteConfig {
  url: string;
  key: string;
}

const remoteFile = (env: NodeJS.ProcessEnv) => join(homeDir(env), "remote.json");

export function loadRemote(env: NodeJS.ProcessEnv = process.env): RemoteConfig | null {
  if (env.TASK_RUNNER_REMOTE_URL && env.TASK_RUNNER_REMOTE_KEY) {
    return { url: env.TASK_RUNNER_REMOTE_URL.replace(/\/+$/, ""), key: env.TASK_RUNNER_REMOTE_KEY };
  }
  try {
    const parsed = JSON.parse(readFileSync(remoteFile(env), "utf8")) as Partial<RemoteConfig>;
    return parsed.url && parsed.key ? { url: parsed.url.replace(/\/+$/, ""), key: parsed.key } : null;
  } catch {
    return null;
  }
}

export function saveRemote(config: RemoteConfig, env: NodeJS.ProcessEnv = process.env): void {
  const file = remoteFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function clearRemote(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = remoteFile(env);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

// ─── This device ──────────────────────────────────────────

export interface DeviceInfo {
  id: string;
  label: string;
  platform: string;
}

const deviceFile = (env: NodeJS.ProcessEnv) => join(homeDir(env), "device.json");

/** A stable id for this machine, created on first use. The label is what you see in the web page. */
export function deviceInfo(env: NodeJS.ProcessEnv = process.env): DeviceInfo {
  const file = deviceFile(env);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DeviceInfo>;
    if (parsed.id && parsed.label) return { id: parsed.id, label: parsed.label, platform: parsed.platform ?? platform() };
  } catch {
    // first run
  }
  const info: DeviceInfo = {
    id: `dev-${crypto.randomUUID().slice(0, 8)}`,
    label: env.TASK_RUNNER_DEVICE_LABEL || hostname().replace(/\.local$/, ""),
    platform: platform(),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(info));
  return info;
}

export function setDeviceLabel(label: string, env: NodeJS.ProcessEnv = process.env): DeviceInfo {
  const info = { ...deviceInfo(env), label: label.trim().slice(0, 60) };
  writeFileSync(deviceFile(env), JSON.stringify(info));
  return info;
}

// ─── Rules client: the same calls against local SQLite or the Worker ──

export interface RulesClient {
  mode: "local" | "remote";
  resolve(context: RuleContext): Promise<ResolvedRules & { pending: number }>;
  listDocs(): Promise<RuleDoc[]>;
  setDoc(key: RuleKey, body: string): Promise<unknown>;
  listProposals(status?: "pending" | "approved" | "rejected" | "all"): Promise<Proposal[]>;
  propose(input: { key: RuleKey; mode?: string; text: string; reason?: string | null; author?: string }): Promise<Proposal>;
  approve(id: string, text?: string): Promise<unknown>;
  reject(id: string): Promise<unknown>;
  listDevices(): Promise<Array<{ id: string; label: string; platform: string | null; last_seen: number }>>;
  registerDevice(device: DeviceInfo): Promise<unknown>;
  renameDevice(id: string, label: string): Promise<unknown>;
}

export class LocalRulesClient implements RulesClient {
  readonly mode = "local" as const;
  private readonly rules: RulesStore;

  constructor(rules: RulesStore) {
    this.rules = rules;
  }

  async resolve(context: RuleContext) {
    return { ...this.rules.resolve(context), pending: this.rules.pendingCount() };
  }
  async listDocs() { return this.rules.listDocs(); }
  async setDoc(key: RuleKey, body: string) { return this.rules.setDoc(key, body, "user"); }
  async listProposals(status: "pending" | "approved" | "rejected" | "all" = "pending") { return this.rules.listProposals(status); }
  async propose(input: Parameters<RulesStore["propose"]>[0]) { return this.rules.propose(input); }
  async approve(id: string, text?: string) { return this.rules.approve(id, text); }
  async reject(id: string) { return this.rules.reject(id); }
  async listDevices() { return this.rules.listDevices() as Array<{ id: string; label: string; platform: string | null; last_seen: number }>; }
  async registerDevice(device: DeviceInfo) { return this.rules.registerDevice(device); }
  async renameDevice(id: string, label: string) { return this.rules.renameDevice(id, label); }
}

export class RemoteRulesClient implements RulesClient {
  readonly mode = "remote" as const;
  private readonly config: RemoteConfig;
  private readonly timeoutMs: number;

  constructor(config: RemoteConfig, timeoutMs = 8000) {
    this.config = config;
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: string, path: string, options: { query?: Record<string, string | null | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.config.url}/api${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v) url.searchParams.set(k, v);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.key}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw new Error(data.error ?? `Server answered ${response.status}`);
    return data;
  }

  resolve(context: RuleContext) {
    return this.call<ResolvedRules & { pending: number }>("GET", "/rules/resolve", { query: { project: context.project, org: context.org, device: context.device } });
  }
  async listDocs() { return (await this.call<{ docs: RuleDoc[] }>("GET", "/rules/docs")).docs; }
  setDoc(key: RuleKey, body: string) { return this.call("PUT", "/rules/docs", { body: { ...key, body } }); }
  async listProposals(status: "pending" | "approved" | "rejected" | "all" = "pending") {
    return (await this.call<{ proposals: Proposal[] }>("GET", "/rules/proposals", { query: { status } })).proposals;
  }
  async propose(input: Parameters<RulesStore["propose"]>[0]) {
    return (await this.call<{ proposal: Proposal }>("POST", "/rules/proposals", { body: { ...input.key, mode: input.mode, text: input.text, reason: input.reason, author: input.author } })).proposal;
  }
  approve(id: string, text?: string) { return this.call("POST", "/rules/proposals/approve", { body: { id, text } }); }
  reject(id: string) { return this.call("POST", "/rules/proposals/reject", { body: { id } }); }
  async listDevices() { return (await this.call<{ devices: Array<{ id: string; label: string; platform: string | null; last_seen: number }> }>("GET", "/devices")).devices; }
  registerDevice(device: DeviceInfo) { return this.call("POST", "/devices", { body: device }); }
  renameDevice(id: string, label: string) { return this.call("PUT", "/devices", { body: { id, label } }); }
}

/** The Worker when a login exists, the local database otherwise. */
export function openRulesClient(db: Db, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): RulesClient {
  const remote = loadRemote(options.env);
  return remote ? new RemoteRulesClient(remote, options.timeoutMs) : new LocalRulesClient(new RulesStore(db));
}

// ─── Last good answer, for when the Worker cannot be reached ──

const cacheFile = (env: NodeJS.ProcessEnv) => join(homeDir(env), "rules-cache.json");

export interface CachedRules {
  text: string;
  at: number;
}

export function readRulesCache(ctx: RuleContext, env: NodeJS.ProcessEnv = process.env): CachedRules | null {
  try {
    const all = JSON.parse(readFileSync(cacheFile(env), "utf8")) as Record<string, CachedRules>;
    return all[cacheKey(ctx)] ?? null;
  } catch {
    return null;
  }
}

export function writeRulesCache(ctx: RuleContext, text: string, env: NodeJS.ProcessEnv = process.env): void {
  let all: Record<string, CachedRules> = {};
  try {
    all = JSON.parse(readFileSync(cacheFile(env), "utf8"));
  } catch {
    // first write
  }
  all[cacheKey(ctx)] = { text, at: Math.floor(Date.now() / 1000) };
  mkdirSync(dirname(cacheFile(env)), { recursive: true, mode: 0o700 });
  writeFileSync(cacheFile(env), JSON.stringify(all));
}

const cacheKey = (ctx: RuleContext) => `${ctx.project ?? ""}|${ctx.org ?? ""}|${ctx.device ?? ""}`;

/** Resolves rules for a hook: fresh when reachable, the last good copy (marked stale) when not. */
export async function resolveForHook(
  client: RulesClient,
  ctx: RuleContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ text: string; pending: number; stale: boolean; error?: string }> {
  try {
    const resolved = await client.resolve(ctx);
    if (client.mode === "remote") writeRulesCache(ctx, resolved.text, env);
    return { text: resolved.text, pending: resolved.pending, stale: false };
  } catch (error) {
    const cached = readRulesCache(ctx, env);
    const reason = error instanceof Error ? error.message : String(error);
    return cached
      ? { text: cached.text, pending: 0, stale: true, error: reason }
      : { text: "", pending: 0, stale: false, error: reason };
  }
}
