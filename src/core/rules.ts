import type { Db, Row, SqlValue } from "./db.ts";
import { StoreError, assertIn, required } from "./errors.ts";

export const RULE_SCOPES = ["global", "device", "org", "project", "project_device"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

export const MAX_DOC_CHARS = 4000;
export const MAX_RESOLVED_CHARS = 8000;

export interface RuleKey {
  scope: RuleScope;
  /** Organization name or project key, depending on the scope. */
  ref?: string | null;
  device?: string | null;
}

export interface RuleContext {
  project?: string | null;
  org?: string | null;
  device?: string | null;
}

export interface ResolvedPart {
  scope: RuleScope;
  label: string;
  chars: number;
}

export interface ResolvedRules {
  text: string;
  chars: number;
  parts: ResolvedPart[];
  truncated: boolean;
}

/** Least specific first: a later section wins when two sections disagree. */
const ORDER: RuleScope[] = ["global", "device", "org", "project", "project_device"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rule_docs (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    UNIQUE (scope, ref, device)
  );
  CREATE TABLE IF NOT EXISTS rule_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rule_revisions_doc ON rule_revisions(doc_id, version);
  CREATE TABLE IF NOT EXISTS rule_proposals (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    ref TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL,
    text TEXT NOT NULL,
    reason TEXT,
    author TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_rule_proposals_status ON rule_proposals(status, created_at);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    platform TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
`;

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Fills in what the scope implies and rejects what it forbids. */
export function normalizeKey(input: RuleKey): { scope: RuleScope; ref: string; device: string } {
  const scope = assertIn(input.scope, RULE_SCOPES, "scope");
  const ref = (input.ref ?? "").trim();
  const device = (input.device ?? "").trim();
  const needsRef = scope === "org" || scope === "project" || scope === "project_device";
  const needsDevice = scope === "device" || scope === "project_device";
  if (needsRef && !ref) {
    throw new StoreError("invalid", `scope '${scope}' needs ${scope === "org" ? "an organization" : "a project"}`);
  }
  if (needsDevice && !device) throw new StoreError("invalid", `scope '${scope}' needs a device`);
  return { scope, ref: needsRef ? ref : "", device: needsDevice ? device : "" };
}

export interface RuleDoc {
  id: string;
  scope: RuleScope;
  ref: string;
  device: string;
  body: string;
  version: number;
  updated_at: number;
}

export interface Proposal {
  id: string;
  scope: RuleScope;
  ref: string;
  device: string;
  mode: "append" | "replace";
  text: string;
  reason: string | null;
  author: string;
  status: "pending" | "approved" | "rejected";
  created_at: number;
  decided_at: number | null;
}

/**
 * Rules the agent must follow, by scope: everywhere, one device, one organization, one project,
 * or one project on one device. Runs on node:sqlite locally and on Durable Object SQLite in the
 * Worker. The agent can only propose; a person approves.
 */
export class RulesStore {
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(db: Db, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.clock = clock;
    db.exec(SCHEMA);
  }

  // ─── Documents ─────────────────────────────────────────

  listDocs(): RuleDoc[] {
    return this.db
      .all<RuleDoc>("SELECT id, scope, ref, device, body, version, updated_at FROM rule_docs")
      .sort((a, b) => ORDER.indexOf(a.scope) - ORDER.indexOf(b.scope) || a.ref.localeCompare(b.ref) || a.device.localeCompare(b.device));
  }

  getDoc(key: RuleKey): RuleDoc | null {
    const k = normalizeKey(key);
    return (
      this.db.get<RuleDoc>(
        "SELECT id, scope, ref, device, body, version, updated_at FROM rule_docs WHERE scope = ? AND ref = ? AND device = ?",
        k.scope, k.ref, k.device,
      ) ?? null
    );
  }

  /** Writes the whole document. An empty body removes it. */
  setDoc(key: RuleKey, body: string, source = "user") {
    const k = normalizeKey(key);
    const text = body.replace(/\r\n/g, "\n").trim();
    if (text.length > MAX_DOC_CHARS) {
      throw new StoreError("invalid", `A rule document is limited to ${MAX_DOC_CHARS} characters (this one has ${text.length}). Keep rules short.`);
    }
    return this.db.transaction(() => {
      const existing = this.getDoc(k);
      const t = this.clock();
      if (text === "") {
        if (existing) {
          this.db.run("DELETE FROM rule_docs WHERE id = ?", existing.id);
          this.revision(existing.id, existing.version + 1, "", source);
        }
        return { id: existing?.id ?? null, version: existing ? existing.version + 1 : 0, removed: Boolean(existing) };
      }
      if (existing) {
        if (existing.body === text) return { id: existing.id, version: existing.version, removed: false };
        const version = existing.version + 1;
        this.db.run("UPDATE rule_docs SET body = ?, version = ?, updated_at = ? WHERE id = ?", text, version, t, existing.id);
        this.revision(existing.id, version, text, source);
        return { id: existing.id, version, removed: false };
      }
      const id = newId("rule");
      this.db.run(
        "INSERT INTO rule_docs (id, scope, ref, device, body, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
        id, k.scope, k.ref, k.device, text, t,
      );
      this.revision(id, 1, text, source);
      return { id, version: 1, removed: false };
    });
  }

  deleteDoc(id: string) {
    required(id, "id");
    const doc = this.db.get<RuleDoc>("SELECT id, version FROM rule_docs WHERE id = ?", id);
    if (!doc) throw new StoreError("not_found", `Rule document '${id}' not found`);
    this.db.transaction(() => {
      this.db.run("DELETE FROM rule_docs WHERE id = ?", id);
      this.revision(id, doc.version + 1, "", "user");
    });
    return { deleted: id };
  }

  revisions(docId: string) {
    return this.db.all(
      "SELECT version, body, source, at FROM rule_revisions WHERE doc_id = ? ORDER BY version DESC LIMIT 50",
      required(docId, "doc_id"),
    );
  }

  private revision(docId: string, version: number, body: string, source: string): void {
    this.db.run(
      "INSERT INTO rule_revisions (doc_id, version, body, source, at) VALUES (?, ?, ?, ?, ?)",
      docId, version, body, source, this.clock(),
    );
  }

  // ─── Resolving ─────────────────────────────────────────

  resolve(context: RuleContext, options: { maxChars?: number } = {}): ResolvedRules {
    const max = options.maxChars ?? MAX_RESOLVED_CHARS;
    const wanted: Array<{ key: RuleKey; label: string }> = [{ key: { scope: "global" }, label: "Everywhere" }];
    const deviceName = context.device ? (this.deviceLabel(context.device) ?? context.device) : null;

    if (context.device) wanted.push({ key: { scope: "device", device: context.device }, label: `This device (${deviceName})` });
    if (context.org) wanted.push({ key: { scope: "org", ref: context.org }, label: `Organization ${context.org}` });
    if (context.project) wanted.push({ key: { scope: "project", ref: context.project }, label: `Project ${context.project}` });
    if (context.project && context.device) {
      wanted.push({ key: { scope: "project_device", ref: context.project, device: context.device }, label: `Project ${context.project} on this device` });
    }

    const parts: Array<ResolvedPart & { body: string }> = [];
    for (const w of wanted) {
      const doc = this.getDoc(w.key);
      if (doc) parts.push({ scope: doc.scope, label: w.label, chars: doc.body.length, body: doc.body });
    }

    let truncated = false;
    let total = parts.reduce((n, p) => n + p.chars, 0);
    // Over budget: the broadest sections give way first, the specific ones stay whole.
    for (let i = 0; i < parts.length && total > max; i++) {
      const over = total - max;
      const cut = Math.min(parts[i].body.length, over);
      parts[i].body = cut >= parts[i].body.length ? "" : `${parts[i].body.slice(0, parts[i].body.length - cut).trimEnd()}\n[cut: rules exceed ${max} characters]`;
      total -= cut;
      truncated = true;
    }

    const used = parts.filter((p) => p.body !== "");
    if (used.length === 0) return { text: "", chars: 0, parts: [], truncated };

    const text = [
      "RULES from the user, set in Task Runner. Follow them. When two sections disagree, the later (more specific) one wins; the repository's own CLAUDE.md still applies.",
      ...used.map((p) => `## ${p.label}\n${p.body}`),
    ].join("\n\n");
    return { text, chars: text.length, parts: used.map(({ scope, label, chars }) => ({ scope, label, chars })), truncated };
  }

  // ─── Proposals ─────────────────────────────────────────

  propose(input: { key: RuleKey; mode?: string; text: string; reason?: string | null; author?: string }): Proposal {
    const k = normalizeKey(input.key);
    const mode = assertIn(input.mode ?? "append", ["append", "replace"] as const, "mode");
    const text = required(input.text, "text").trim();
    if (text.length > MAX_DOC_CHARS) throw new StoreError("invalid", `A proposal is limited to ${MAX_DOC_CHARS} characters`);

    const duplicate = this.db.get(
      "SELECT 1 FROM rule_proposals WHERE status = 'pending' AND scope = ? AND ref = ? AND device = ? AND mode = ? AND text = ?",
      k.scope, k.ref, k.device, mode, text,
    );
    if (duplicate) throw new StoreError("conflict", "The same proposal is already waiting for approval");
    const pending = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rule_proposals WHERE status = 'pending'")?.n ?? 0;
    if (pending >= 50) throw new StoreError("conflict", "Too many proposals are waiting. Approve or reject some first.");

    const id = newId("prop");
    this.db.run(
      `INSERT INTO rule_proposals (id, scope, ref, device, mode, text, reason, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, k.scope, k.ref, k.device, mode, text, input.reason ?? null, input.author ?? "agent", this.clock(),
    );
    return this.getProposal(id)!;
  }

  getProposal(id: string): Proposal | null {
    return (
      this.db.get<Proposal>(
        "SELECT id, scope, ref, device, mode, text, reason, author, status, created_at, decided_at FROM rule_proposals WHERE id = ?",
        id,
      ) ?? null
    );
  }

  listProposals(status: "pending" | "approved" | "rejected" | "all" = "pending"): Proposal[] {
    const where = status === "all" ? "" : " WHERE status = ?";
    const values: SqlValue[] = status === "all" ? [] : [status];
    return this.db.all<Proposal>(
      `SELECT id, scope, ref, device, mode, text, reason, author, status, created_at, decided_at
       FROM rule_proposals${where} ORDER BY created_at DESC LIMIT 100`,
      ...values,
    );
  }

  approve(id: string, editedText?: string) {
    const proposal = this.getProposal(required(id, "id"));
    if (!proposal) throw new StoreError("not_found", `Proposal '${id}' not found`);
    if (proposal.status !== "pending") throw new StoreError("conflict", `Proposal '${id}' was already ${proposal.status}`);

    return this.db.transaction(() => {
      const key: RuleKey = { scope: proposal.scope, ref: proposal.ref, device: proposal.device };
      const text = (editedText ?? proposal.text).trim();
      const current = this.getDoc(key)?.body ?? "";
      const next = proposal.mode === "replace" || current === "" ? text : `${current}\n${text}`;
      const written = this.setDoc(key, next, `proposal ${proposal.id} by ${proposal.author}`);
      this.db.run("UPDATE rule_proposals SET status = 'approved', decided_at = ? WHERE id = ?", this.clock(), id);
      return { approved: id, doc_id: written.id, version: written.version };
    });
  }

  reject(id: string) {
    const proposal = this.getProposal(required(id, "id"));
    if (!proposal) throw new StoreError("not_found", `Proposal '${id}' not found`);
    if (proposal.status !== "pending") throw new StoreError("conflict", `Proposal '${id}' was already ${proposal.status}`);
    this.db.run("UPDATE rule_proposals SET status = 'rejected', decided_at = ? WHERE id = ?", this.clock(), id);
    return { rejected: id };
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rule_proposals WHERE status = 'pending'")?.n ?? 0;
  }

  // ─── Devices ───────────────────────────────────────────

  registerDevice(input: { id: string; label: string; platform?: string | null }) {
    const id = required(input.id, "id").trim();
    const label = required(input.label, "label").trim().slice(0, 60);
    const t = this.clock();
    this.db.run(
      `INSERT INTO devices (id, label, platform, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, platform = COALESCE(excluded.platform, platform)`,
      id, label, input.platform ?? null, t, t,
    );
    return this.db.get<Row>("SELECT id, label, platform, first_seen, last_seen FROM devices WHERE id = ?", id)!;
  }

  renameDevice(id: string, label: string) {
    const clean = required(label, "label").trim().slice(0, 60);
    if (!this.deviceLabel(id)) throw new StoreError("not_found", `Device '${id}' not found`);
    this.db.run("UPDATE devices SET label = ? WHERE id = ?", clean, id);
    return { id, label: clean };
  }

  listDevices() {
    return this.db.all("SELECT id, label, platform, first_seen, last_seen FROM devices ORDER BY last_seen DESC");
  }

  private deviceLabel(id: string): string | null {
    return this.db.get<{ label: string }>("SELECT label FROM devices WHERE id = ?", id)?.label ?? null;
  }
}
