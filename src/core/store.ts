import type { Db, Row, SqlValue } from "./db.ts";
import {
  DEFAULT_CONTEXT_ENTRIES,
  DEFAULT_IMPORTANCE,
  ENTITY_TYPES,
  ENTRY_TYPES,
  GLOBAL_PROJECT,
  IMPORTANCE_HALF_LIFE_DAYS,
  MAX_CONTEXT_ENTRIES,
  MAX_FACT_LENGTH,
  MAX_RECALL_RESULTS,
  MAX_RESULT_SIZE,
  MAX_SEARCH_RESULTS,
  RELATION_TYPES,
  SCOPES,
  STALE_RUNNING_SECONDS,
} from "./constants.ts";
import { StoreError, assertIn, required } from "./errors.ts";
import { fold, foldSql, ftsQuery } from "./fts.ts";
import { migrate } from "./schema.ts";
import type { TaskInput } from "./parser.ts";

const ENTRY_COLS =
  "id, project_key, scope, scope_ref, type, title, content, tags, session_id, created_at";
const ENTITY_COLS =
  "id, project_key, name, entity_type, summary, properties, importance, access_count, last_accessed, created_at, updated_at";

const EXPORT_COLUMNS: Record<string, string[]> = {
  projects: ["key", "project_path", "project_name", "created_at", "updated_at"],
  project_paths: ["path", "project_key", "seen_at"],
  entries: ["id", "project_key", "scope", "scope_ref", "type", "title", "content", "tags", "session_id", "created_at"],
  entities: [
    "id", "project_key", "name", "entity_type", "summary", "properties", "importance",
    "access_count", "last_accessed", "created_at", "updated_at", "valid_until",
  ],
  observations: ["id", "entity_id", "content", "source", "confidence", "created_at", "valid_until", "superseded_by"],
  relations: ["id", "source_id", "target_id", "relation_type", "weight", "context", "created_at", "valid_until"],
  tasks: [
    "project_key", "task_group", "id", "index_num", "title", "content", "status", "result", "error",
    "system_prompt", "started_at", "completed_at", "execution_time_ms", "result_size", "created_at", "branch",
  ],
};

export interface UpsertResult {
  entity_id: string;
  name: string;
  entity_type: string;
  is_new: boolean;
  observations_added: number;
  similar_existing?: Array<{ name: string; entity_type: string }>;
  /** Existing entities named in the new facts that this entity is not linked to yet. */
  link_suggestions?: string[];
}

export interface ExportData {
  format: "task-runner-export";
  version: 1;
  exported_at: number;
  tables: Record<string, Row[]>;
}

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export class Store {
  private readonly db: Db;
  private readonly clock: () => number;

  constructor(db: Db, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.clock = clock;
    migrate(db);
  }

  // ─── Projects ──────────────────────────────────────────

  setContext(input: { project: string; project_path?: string | null; project_name?: string | null }) {
    const project = required(input.project, "project").trim();
    const path = input.project_path ?? null;
    const name = input.project_name ?? null;
    const t = this.clock();

    const existing = this.db.get("SELECT key FROM projects WHERE key = ?", project);
    if (existing) {
      this.db.run(
        "UPDATE projects SET project_path = COALESCE(?, project_path), project_name = COALESCE(?, project_name), updated_at = ? WHERE key = ?",
        path, name, t, project,
      );
    } else {
      this.db.run(
        "INSERT INTO projects (key, project_path, project_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        project, path, name, t, t,
      );
    }

    let samePath: string[] = [];
    if (path) {
      const previous = this.db.get<{ project_key: string }>("SELECT project_key FROM project_paths WHERE path = ?", path);
      if (previous && previous.project_key !== project) samePath = [previous.project_key];
      this.db.run(
        `INSERT INTO project_paths (path, project_key, seen_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET project_key = excluded.project_key, seen_at = excluded.seen_at`,
        path, project, t,
      );
    }

    return { project, created: !existing, same_path_projects: samePath };
  }

  findProjectByPath(path: string): string | null {
    const row = this.db.get<{ key: string }>(
      "SELECT project_key AS key FROM project_paths WHERE path = ?",
      path,
    );
    return row?.key ?? null;
  }

  listProjects() {
    return this.db.all("SELECT key, project_path, project_name, created_at, updated_at FROM projects ORDER BY updated_at DESC");
  }

  deleteProject(key: string) {
    required(key, "project");
    const exists = this.db.get("SELECT key FROM projects WHERE key = ?", key);
    if (!exists) throw new StoreError("not_found", `Project '${key}' not found`);
    this.db.transaction(() => {
      this.db.run("DELETE FROM entries_fts WHERE rowid IN (SELECT seq FROM entries WHERE project_key = ?)", key);
      this.db.run("DELETE FROM entities_fts WHERE rowid IN (SELECT seq FROM entities WHERE project_key = ?)", key);
      this.db.run("DELETE FROM projects WHERE key = ?", key);
    });
    return { deleted: key };
  }

  /** Folds one project into another: used to repair a codebase that was recorded under two keys. */
  mergeProjects(from: string, into: string) {
    required(from, "from");
    required(into, "into");
    if (from === into) throw new StoreError("invalid", "Cannot merge a project into itself");
    if (!this.db.get("SELECT key FROM projects WHERE key = ?", from)) {
      throw new StoreError("not_found", `Project '${from}' not found`);
    }
    this.ensureProject(into);

    return this.db.transaction(() => {
      const moved = { entities: 0, merged_entities: 0, entries: 0, tasks: 0 };

      moved.entries = this.db.all("SELECT 1 FROM entries WHERE project_key = ?", from).length;
      this.db.run("UPDATE entries SET project_key = ? WHERE project_key = ?", into, from);

      for (const group of this.db.all<{ task_group: string }>(
        "SELECT DISTINCT task_group FROM tasks WHERE project_key = ?", from,
      )) {
        const clash = this.db.get("SELECT 1 FROM tasks WHERE project_key = ? AND task_group = ?", into, group.task_group);
        const target = clash ? `${group.task_group}-merged` : group.task_group;
        moved.tasks += this.db.all("SELECT 1 FROM tasks WHERE project_key = ? AND task_group = ?", from, group.task_group).length;
        this.db.run(
          "UPDATE tasks SET project_key = ?, task_group = ? WHERE project_key = ? AND task_group = ?",
          into, target, from, group.task_group,
        );
      }

      for (const e of this.db.all<{ id: string; name: string; entity_type: string }>(
        "SELECT id, name, entity_type FROM entities WHERE project_key = ?", from,
      )) {
        const twin = this.db.get<{ id: string }>(
          "SELECT id FROM entities WHERE project_key = ? AND name = ? COLLATE NOCASE AND entity_type = ?",
          into, e.name, e.entity_type,
        );
        if (!twin) {
          this.db.run("UPDATE entities SET project_key = ? WHERE id = ?", into, e.id);
          moved.entities++;
          continue;
        }
        this.db.run(
          `UPDATE observations SET entity_id = ? WHERE entity_id = ? AND NOT EXISTS (
             SELECT 1 FROM observations o2 WHERE o2.entity_id = ? AND o2.valid_until IS NULL
               AND o2.content = observations.content COLLATE NOCASE)`,
          twin.id, e.id, twin.id,
        );
        this.db.run("UPDATE OR IGNORE relations SET source_id = ? WHERE source_id = ?", twin.id, e.id);
        this.db.run("UPDATE OR IGNORE relations SET target_id = ? WHERE target_id = ?", twin.id, e.id);
        this.db.run("DELETE FROM relations WHERE source_id = ? OR target_id = ? OR source_id = target_id", e.id, e.id);
        this.db.run("DELETE FROM relations WHERE source_id = target_id");
        this.db.run("DELETE FROM entities_fts WHERE rowid = (SELECT seq FROM entities WHERE id = ?)", e.id);
        this.db.run("DELETE FROM entities WHERE id = ?", e.id);
        moved.merged_entities++;
        this.indexEntity(twin.id);
      }

      this.db.run("UPDATE OR REPLACE project_paths SET project_key = ? WHERE project_key = ?", into, from);
      this.db.run("DELETE FROM projects WHERE key = ?", from);
      this.reindexAll();
      return { merged: from, into, ...moved };
    });
  }

  private ensureProject(key: string): void {
    const t = this.clock();
    this.db.run(
      "INSERT INTO projects (key, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at",
      key, t, t,
    );
  }

  // ─── Flat memory entries ───────────────────────────────

  saveEntry(input: {
    project: string;
    type: string;
    title: string;
    content: string;
    scope?: string;
    scope_ref?: string | null;
    tags?: string | null;
    session_id?: string | null;
  }) {
    const project = required(input.project, "project");
    const type = assertIn(input.type, ENTRY_TYPES, "type");
    const title = required(input.title, "title");
    const content = required(input.content, "content");
    const scope = assertIn(input.scope ?? "project", SCOPES, "scope");
    const scopeRef = scope === "project" ? null : (input.scope_ref ?? null);
    if (scope !== "project" && !scopeRef) {
      throw new StoreError("invalid", `scope '${scope}' needs a ${scope === "pr" ? "pr number" : "branch"} in context`);
    }

    this.ensureProject(project);
    const id = newId("entry");
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO entries (id, project_key, scope, scope_ref, type, title, content, tags, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id, project, scope, scopeRef, type, title, content, input.tags ?? null, input.session_id ?? null, this.clock(),
      );
      this.indexEntry(id);
    });
    return { id, project, scope, scope_ref: scopeRef, type };
  }

  getContext(input: { project: string; branch?: string | null; pr?: string | null; all?: boolean; limit?: number; type?: string }) {
    const project = required(input.project, "project");
    const limit = clamp(Math.floor(input.limit ?? DEFAULT_CONTEXT_ENTRIES), 1, MAX_CONTEXT_ENTRIES);
    const values: SqlValue[] = [project];
    let where = "project_key = ?";

    if (!input.all) {
      const scopes = ["scope = 'project'"];
      if (input.branch) {
        scopes.push("(scope = 'branch' AND scope_ref = ?)");
        values.push(input.branch);
      }
      if (input.pr) {
        scopes.push("(scope = 'pr' AND scope_ref = ?)");
        values.push(input.pr);
      }
      where += ` AND (${scopes.join(" OR ")})`;
    }
    if (input.type) {
      where += " AND type = ?";
      values.push(assertIn(input.type, ENTRY_TYPES, "type"));
    }

    const entries = this.db.all(
      `SELECT ${ENTRY_COLS} FROM entries WHERE ${where} ORDER BY created_at DESC, seq DESC LIMIT ?`,
      ...values, limit,
    );
    return { entries, count: entries.length };
  }

  updateEntry(input: { id: string; title?: string; content?: string; type?: string; tags?: string }) {
    const id = required(input.id, "id");
    const existing = this.db.get("SELECT id FROM entries WHERE id = ?", id);
    if (!existing) throw new StoreError("not_found", `Entry '${id}' not found`);

    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (input.title) { sets.push("title = ?"); values.push(input.title); }
    if (input.content) { sets.push("content = ?"); values.push(input.content); }
    if (input.type) { sets.push("type = ?"); values.push(assertIn(input.type, ENTRY_TYPES, "type")); }
    if (input.tags !== undefined) { sets.push("tags = ?"); values.push(input.tags); }
    if (sets.length === 0) throw new StoreError("invalid", "Nothing to update");

    this.db.transaction(() => {
      this.db.run(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
      this.indexEntry(id);
    });
    return { updated: id };
  }

  deleteEntry(id: string) {
    required(id, "id");
    const row = this.db.get<{ seq: number }>("SELECT seq FROM entries WHERE id = ?", id);
    if (!row) throw new StoreError("not_found", `Entry '${id}' not found`);
    this.db.transaction(() => {
      this.db.run("DELETE FROM entries_fts WHERE rowid = ?", row.seq);
      this.db.run("DELETE FROM entries WHERE id = ?", id);
    });
    return { deleted: id };
  }

  searchEntries(input: { q: string; project?: string | null; limit?: number }) {
    const match = ftsQuery(required(input.q, "query"));
    if (!match) return { entries: [], count: 0 };
    const limit = clamp(Math.floor(input.limit ?? MAX_SEARCH_RESULTS), 1, MAX_SEARCH_RESULTS);
    const values: SqlValue[] = [match];
    let projectFilter = "";
    if (input.project) {
      projectFilter = " AND e.project_key = ?";
      values.push(input.project);
    }
    const entries = this.db.all(
      `SELECT ${ENTRY_COLS.split(", ").map((c) => `e.${c}`).join(", ")}
       FROM entries_fts JOIN entries e ON e.seq = entries_fts.rowid
       WHERE entries_fts MATCH ?${projectFilter}
       ORDER BY bm25(entries_fts, 5.0, 1.0, 2.0) LIMIT ?`,
      ...values, limit,
    );
    return { entries, count: entries.length };
  }

  // ─── Knowledge graph ───────────────────────────────────

  upsertEntity(input: {
    project: string;
    name: string;
    entity_type: string;
    summary?: string | null;
    properties?: unknown;
    importance?: number;
    observations?: string[];
  }) {
    const project = required(input.project, "project");
    const name = required(input.name, "name").trim();
    const type = assertIn(input.entity_type, ENTITY_TYPES, "entity_type");
    const properties = input.properties === undefined ? null : JSON.stringify(input.properties);
    const importance = input.importance === undefined ? null : clamp(input.importance, 0, 1);
    const initialImportance = importance ?? DEFAULT_IMPORTANCE[type];
    const t = this.clock();

    this.ensureProject(project);

    return this.db.transaction((): UpsertResult => {
      const existing = this.db.get<{ id: string }>(
        "SELECT id FROM entities WHERE project_key = ? AND name = ? COLLATE NOCASE AND entity_type = ?",
        project, name, type,
      );
      let id: string;
      if (existing) {
        id = existing.id;
        this.db.run(
          `UPDATE entities SET summary = COALESCE(?, summary), properties = COALESCE(?, properties),
             importance = COALESCE(?, importance), valid_until = NULL, updated_at = ?, last_accessed = ?
           WHERE id = ?`,
          input.summary ?? null, properties, importance, t, t, id,
        );
      } else {
        id = newId("ent");
        this.db.run(
          `INSERT INTO entities (id, project_key, name, entity_type, summary, properties, importance, last_accessed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, project, name, type, input.summary ?? null, properties, initialImportance, t, t, t,
        );
      }
      const added = this.insertFacts(id, input.observations ?? []);
      this.indexEntity(id);
      const result: UpsertResult = {
        entity_id: id,
        name,
        entity_type: type,
        is_new: !existing,
        observations_added: added.length,
      };
      if (!existing) {
        const similar = this.similarEntities(project, name, id);
        if (similar.length > 0) result.similar_existing = similar;
      }
      if (added.length > 0) {
        const suggestions = this.linkSuggestions(project, id, (input.observations ?? []).concat(input.summary ?? ""));
        if (suggestions.length > 0) result.link_suggestions = suggestions;
      }
      return result;
    });
  }

  addFacts(input: { project: string; entity_name: string; entity_type?: string; facts: string[] }) {
    if (!input.facts?.length) throw new StoreError("invalid", "facts must contain at least one item");
    const entity = this.resolveEntity(input.project, input.entity_name, input.entity_type);
    return this.db.transaction(() => {
      const added = this.insertFacts(entity.id, input.facts);
      this.db.run("UPDATE entities SET updated_at = ? WHERE id = ?", this.clock(), entity.id);
      this.indexEntity(entity.id);
      return { entity_id: entity.id, added: added.length, skipped_duplicates: input.facts.length - added.length };
    });
  }

  correctFact(input: { project: string; observation_id: string; new_fact?: string }) {
    const obsId = required(input.observation_id, "observation_id");
    const obs = this.db.get<{ id: string; entity_id: string }>(
      `SELECT o.id, o.entity_id FROM observations o JOIN entities e ON e.id = o.entity_id
       WHERE o.id = ? AND e.project_key = ? AND o.valid_until IS NULL`,
      obsId, input.project,
    );
    if (!obs) throw new StoreError("not_found", `Fact '${obsId}' not found`);

    const t = this.clock();
    return this.db.transaction(() => {
      let newId_: string | null = null;
      if (input.new_fact?.trim()) {
        newId_ = newId("obs");
        this.db.run(
          "INSERT INTO observations (id, entity_id, content, created_at) VALUES (?, ?, ?, ?)",
          newId_, obs.entity_id, input.new_fact.trim(), t,
        );
      }
      this.db.run("UPDATE observations SET valid_until = ?, superseded_by = ? WHERE id = ?", t, newId_, obsId);
      this.db.run("UPDATE entities SET updated_at = ? WHERE id = ?", t, obs.entity_id);
      this.indexEntity(obs.entity_id);
      return { old_id: obsId, new_id: newId_, invalidated: newId_ === null };
    });
  }

  link(input: {
    project: string;
    from_name: string;
    from_type?: string;
    to_name: string;
    to_type?: string;
    relation_type: string;
    context?: string | null;
    weight?: number;
  }) {
    const type = assertIn(input.relation_type, RELATION_TYPES, "relation_type");
    const from = this.resolveEntity(input.project, input.from_name, input.from_type);
    const to = this.resolveEntity(input.project, input.to_name, input.to_type);
    if (from.id === to.id) throw new StoreError("invalid", "Cannot link an entity to itself");

    const weight = clamp(input.weight ?? 1, 0, 10);
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM relations WHERE source_id = ? AND target_id = ? AND relation_type = ?",
      from.id, to.id, type,
    );

    if (existing) {
      this.db.run(
        "UPDATE relations SET weight = ?, context = COALESCE(?, context), valid_until = NULL WHERE id = ?",
        weight, input.context ?? null, existing.id,
      );
    } else {
      this.db.run(
        "INSERT INTO relations (id, source_id, target_id, relation_type, weight, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        newId("rel"), from.id, to.id, type, weight, input.context ?? null, this.clock(),
      );
    }
    return {
      is_new: !existing,
      from: `${from.name} (${from.entity_type})`,
      relation: type,
      to: `${to.name} (${to.entity_type})`,
    };
  }

  deleteRelation(id: string) {
    required(id, "id");
    this.db.run("UPDATE relations SET valid_until = ? WHERE id = ? AND valid_until IS NULL", this.clock(), id);
    return { relation_id: id, invalidated: true };
  }

  forget(input: { project: string; name: string; entity_type?: string }) {
    const entity = this.resolveEntity(input.project, input.name, input.entity_type);
    const t = this.clock();
    this.db.transaction(() => {
      this.db.run("UPDATE entities SET valid_until = ?, updated_at = ? WHERE id = ?", t, t, entity.id);
      this.db.run("UPDATE observations SET valid_until = ? WHERE entity_id = ? AND valid_until IS NULL", t, entity.id);
      this.db.run(
        "UPDATE relations SET valid_until = ? WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL",
        t, entity.id, entity.id,
      );
      this.indexEntity(entity.id);
    });
    return { forgotten: `${entity.name} (${entity.entity_type})`, entity_id: entity.id };
  }

  getEntity(input: { project: string; name: string; entity_type?: string }) {
    const entity = this.resolveEntity(input.project, input.name, input.entity_type);
    this.bumpAccess([entity.id]);
    return {
      entity,
      observations: this.facts(entity.id, 100),
      relations: {
        outgoing: this.db.all(
          `SELECT r.id, r.relation_type, r.weight, r.context, e.name AS target_name, e.entity_type AS target_type
           FROM relations r JOIN entities e ON e.id = r.target_id
           WHERE r.source_id = ? AND r.valid_until IS NULL AND e.valid_until IS NULL`,
          entity.id,
        ),
        incoming: this.db.all(
          `SELECT r.id, r.relation_type, r.weight, r.context, e.name AS source_name, e.entity_type AS source_type
           FROM relations r JOIN entities e ON e.id = r.source_id
           WHERE r.target_id = ? AND r.valid_until IS NULL AND e.valid_until IS NULL`,
          entity.id,
        ),
      },
    };
  }

  /** Resolves an entity id (as the graph view knows it) to the project and name the other methods take. */
  findEntityById(id: string): { project_key: string; name: string; entity_type: string } | null {
    return (
      this.db.get<{ project_key: string; name: string; entity_type: string }>(
        "SELECT project_key, name, entity_type FROM entities WHERE id = ? AND valid_until IS NULL",
        id,
      ) ?? null
    );
  }

  describe(input: { project: string; name: string; entity_type?: string; hops?: number }) {
    const detail = this.getEntity(input);
    return { ...detail, graph_neighbors: this.neighbors(detail.entity.id as string, input.hops ?? 2) };
  }

  neighbors(entityId: string, hops = 2) {
    const maxHops = clamp(Math.floor(hops), 1, 3);
    return this.db.all(
      `WITH RECURSIVE walk(entity_id, hop, path) AS (
         SELECT ?, 0, ',' || ? || ','
         UNION ALL
         SELECT nxt.id, w.hop + 1, w.path || nxt.id || ','
         FROM walk w
         JOIN relations r ON (r.source_id = w.entity_id OR r.target_id = w.entity_id) AND r.valid_until IS NULL
         JOIN (SELECT id FROM entities WHERE valid_until IS NULL) nxt
           ON nxt.id = CASE WHEN r.source_id = w.entity_id THEN r.target_id ELSE r.source_id END
         WHERE w.hop < ? AND instr(w.path, ',' || nxt.id || ',') = 0
       )
       SELECT e.id, e.name, e.entity_type, e.summary, e.importance, MIN(w.hop) AS hop
       FROM walk w JOIN entities e ON e.id = w.entity_id
       WHERE w.hop > 0
       GROUP BY e.id
       ORDER BY hop, e.importance DESC
       LIMIT 50`,
      entityId, entityId, maxHops,
    );
  }

  recall(input: { project: string; q: string; entity_type?: string; limit?: number; all_projects?: boolean }) {
    const match = ftsQuery(required(input.q, "query"));
    if (!match) return { entities: [], entries: [] };

    const limit = clamp(Math.floor(input.limit ?? 10), 1, MAX_RECALL_RESULTS);
    const values: SqlValue[] = [match];
    let filter = "e.valid_until IS NULL";
    if (!input.all_projects) {
      filter += " AND e.project_key IN (?, ?)";
      values.push(required(input.project, "project"), GLOBAL_PROJECT);
    }
    if (input.entity_type) {
      filter += " AND e.entity_type = ?";
      values.push(assertIn(input.entity_type, ENTITY_TYPES, "entity_type"));
    }

    const candidates = this.db.all<Row & { rank: number }>(
      `SELECT ${ENTITY_COLS.split(", ").map((c) => `e.${c}`).join(", ")}, bm25(entities_fts, 8.0, 3.0, 1.0) AS rank
       FROM entities_fts JOIN entities e ON e.seq = entities_fts.rowid
       WHERE entities_fts MATCH ? AND ${filter}
       ORDER BY rank LIMIT ?`,
      ...values, limit * 3,
    );

    const now = this.clock();
    const best = Math.min(...candidates.map((c) => c.rank), -1e-9);
    const scored: Array<Row & { score: number }> = candidates.map((c) => {
      const relevance = best === 0 ? 1 : c.rank / best;
      const ageDays = Math.max(0, (now - (c.last_accessed as number)) / 86400);
      const accessBoost = 1 + 0.1 * Math.log((c.access_count as number) + 1);
      const importance = Math.min(1, (c.importance as number) * Math.pow(0.5, ageDays / IMPORTANCE_HALF_LIFE_DAYS) * accessBoost);
      const recency = 1 / (1 + ageDays / 7);
      const { rank: _rank, ...entity } = c;
      return { ...entity, score: Number((relevance * 0.55 + importance * 0.3 + recency * 0.15).toFixed(4)) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    const entities: Array<Row & { score: number; observations: Row[] }> = top.map((e) => ({
      ...e,
      observations: this.facts(e.id as string, 5),
    }));
    this.bumpAccess(top.map((e) => e.id as string));

    const entryValues: SqlValue[] = [match];
    let entryFilter = "";
    if (!input.all_projects) {
      entryFilter = " AND e.project_key = ?";
      entryValues.push(input.project);
    }
    const entries = this.db.all(
      `SELECT e.id, e.project_key, e.type, e.scope, e.scope_ref, e.title, substr(e.content, 1, 300) AS content, e.created_at
       FROM entries_fts JOIN entries e ON e.seq = entries_fts.rowid
       WHERE entries_fts MATCH ?${entryFilter}
       ORDER BY bm25(entries_fts, 5.0, 1.0, 2.0) LIMIT 5`,
      ...entryValues,
    );

    return { entities, entries };
  }

  graphAll(project: string) {
    required(project, "project");
    const entities = this.db.all(
      `SELECT ${ENTITY_COLS.split(", ").map((c) => `e.${c}`).join(", ")},
              (SELECT COUNT(*) FROM observations o WHERE o.entity_id = e.id AND o.valid_until IS NULL) AS observation_count
       FROM entities e WHERE e.project_key = ? AND e.valid_until IS NULL ORDER BY e.importance DESC`,
      project,
    );
    const relations = this.db.all(
      `SELECT r.id, r.source_id, r.target_id, r.relation_type, r.weight, r.context,
              s.name AS source_name, s.entity_type AS source_type,
              t.name AS target_name, t.entity_type AS target_type
       FROM relations r
       JOIN entities s ON s.id = r.source_id
       JOIN entities t ON t.id = r.target_id
       WHERE s.project_key = ? AND r.valid_until IS NULL AND s.valid_until IS NULL AND t.valid_until IS NULL`,
      project,
    );
    return { entities, relations, entity_count: entities.length, relation_count: relations.length };
  }

  graphStats(project: string) {
    required(project, "project");
    const count = (sql: string) => (this.db.get<{ n: number }>(sql, project)?.n ?? 0);
    return {
      entities: count("SELECT COUNT(*) AS n FROM entities WHERE project_key = ? AND valid_until IS NULL"),
      relations: count(
        `SELECT COUNT(*) AS n FROM relations r JOIN entities e ON e.id = r.source_id
         WHERE e.project_key = ? AND r.valid_until IS NULL`,
      ),
      observations: count(
        `SELECT COUNT(*) AS n FROM observations o JOIN entities e ON e.id = o.entity_id
         WHERE e.project_key = ? AND o.valid_until IS NULL AND e.valid_until IS NULL`,
      ),
      orphan_entities: count(
        `SELECT COUNT(*) AS n FROM entities e
         WHERE e.project_key = ? AND e.valid_until IS NULL
           AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.valid_until IS NULL AND (r.source_id = e.id OR r.target_id = e.id))`,
      ),
      entries: count("SELECT COUNT(*) AS n FROM entries WHERE project_key = ?"),
      tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE project_key = ?"),
      entity_types: this.db.all(
        "SELECT entity_type, COUNT(*) AS count FROM entities WHERE project_key = ? AND valid_until IS NULL GROUP BY entity_type ORDER BY count DESC",
        project,
      ),
      top_entities: this.db.all(
        `SELECT name, entity_type, importance, access_count, last_accessed FROM entities
         WHERE project_key = ? AND valid_until IS NULL ORDER BY importance DESC, access_count DESC LIMIT 10`,
        project,
      ),
    };
  }

  entityNames(project: string, entityType: string): string[] {
    return this.db
      .all<{ name: string }>(
        "SELECT name FROM entities WHERE project_key = ? AND entity_type = ? AND valid_until IS NULL",
        project, assertIn(entityType, ENTITY_TYPES, "entity_type"),
      )
      .map((r) => r.name);
  }

  consolidate(input: { project: string; max_age_days?: number }) {
    const days = clamp(input.max_age_days ?? 90, 1, 3650);
    const cutoff = this.clock() - days * 86400;
    const entities = this.db.all(
      `SELECT e.id, e.name, e.entity_type, e.importance, e.access_count, e.last_accessed,
              (SELECT COUNT(*) FROM observations o WHERE o.entity_id = e.id AND o.valid_until IS NULL) AS observation_count
       FROM entities e
       WHERE e.project_key = ? AND e.valid_until IS NULL AND e.last_accessed < ? AND e.importance < 0.3
       ORDER BY e.importance ASC, e.last_accessed ASC LIMIT 20`,
      input.project, cutoff,
    );
    const entries = this.db.all(
      "SELECT id, type, scope, title, created_at FROM entries WHERE project_key = ? AND created_at < ? ORDER BY created_at ASC LIMIT 20",
      input.project, cutoff,
    );
    return { entity_candidates: entities, entry_candidates: entries, max_age_days: days };
  }

  digest(project: string, limits: { entities?: number; entries?: number; branch?: string | null } = {}) {
    required(project, "project");
    const pick = (key: string, limit: number): Array<Row & { facts: string[] }> =>
      this.db
        .all<Row>(
          `SELECT id, name, entity_type, summary FROM entities
           WHERE project_key = ? AND valid_until IS NULL
           ORDER BY importance DESC, access_count DESC, updated_at DESC LIMIT ?`,
          key, limit,
        )
        .map((e) => ({ ...e, facts: this.facts(e.id as string, 2).map((f) => f.content as string) }));

    const entities = pick(project, limits.entities ?? 8);
    const globalEntities = project === GLOBAL_PROJECT ? [] : pick(GLOBAL_PROJECT, 4);

    const entries = this.db.all(
      "SELECT type, title, created_at FROM entries WHERE project_key = ? AND scope = 'project' ORDER BY created_at DESC, seq DESC LIMIT ?",
      project, limits.entries ?? 5,
    );
    const group = this.latestGroup(project, limits.branch);
    const tasks = group ? this.taskSummary(project, group) : null;
    return { entities, global_entities: globalEntities, entries, tasks, stats: this.graphStats(project) };
  }

  // ─── Tasks ─────────────────────────────────────────────

  createTasks(input: {
    project: string;
    task_group: string;
    tasks: TaskInput[];
    system_prompt?: string | null;
    replace?: boolean;
    branch?: string | null;
  }) {
    const project = required(input.project, "project");
    const group = required(input.task_group, "task_group");
    if (!input.tasks?.length) throw new StoreError("invalid", "At least one task is required");

    this.ensureProject(project);
    return this.db.transaction(() => {
      const progressed = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_key = ? AND task_group = ? AND status <> 'pending'",
        project, group,
      );
      if ((progressed?.n ?? 0) > 0 && !input.replace) {
        throw new StoreError(
          "conflict",
          `Task group '${group}' already has progress. Use another name or pass replace: true.`,
        );
      }
      this.db.run("DELETE FROM tasks WHERE project_key = ? AND task_group = ?", project, group);

      const t = this.clock();
      const created = input.tasks.map((task, i) => {
        const id = `task-${String(i + 1).padStart(3, "0")}`;
        this.db.run(
          `INSERT INTO tasks (project_key, task_group, id, index_num, title, content, system_prompt, created_at, branch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          project, group, id, i, required(task.title, "task title"), required(task.content, "task content"),
          input.system_prompt ?? null, t, input.branch ?? null,
        );
        return { id, title: task.title, status: "pending" };
      });
      return { task_group: group, task_count: created.length, tasks: created };
    });
  }

  nextTask(input: { project: string; task_group?: string | null; branch?: string | null }) {
    const group = this.groupOrLatest(input.project, input.task_group, input.branch);
    return this.db.transaction(() => {
      const t = this.clock();
      this.db.run(
        "UPDATE tasks SET status = 'pending', started_at = NULL WHERE project_key = ? AND task_group = ? AND status = 'running' AND started_at < ?",
        input.project, group, t - STALE_RUNNING_SECONDS,
      );
      const task = this.db.get<Row>(
        "SELECT id, index_num, title, content, system_prompt FROM tasks WHERE project_key = ? AND task_group = ? AND status = 'pending' ORDER BY index_num LIMIT 1",
        input.project, group,
      );
      if (!task) {
        return { done: true, task_group: group, summary: this.taskSummary(input.project, group) };
      }
      this.db.run(
        "UPDATE tasks SET status = 'running', started_at = ? WHERE project_key = ? AND task_group = ? AND id = ?",
        t, input.project, group, task.id as string,
      );
      return {
        done: false,
        task_group: group,
        task: { id: task.id, index: task.index_num, title: task.title, content: task.content, system_prompt: task.system_prompt },
      };
    });
  }

  completeTask(input: { project: string; task_id: string; task_group?: string | null; result: string; execution_time_ms?: number | null }) {
    const task = this.findTask(input.project, input.task_id, input.task_group);
    const result = required(input.result, "result");
    const t = this.clock();
    const elapsed =
      input.execution_time_ms ?? (task.started_at ? (t - (task.started_at as number)) * 1000 : null);
    const truncated = result.length > MAX_RESULT_SIZE;

    this.db.run(
      `UPDATE tasks SET status = 'completed', completed_at = ?, result = ?, result_size = ?, execution_time_ms = ?, error = NULL
       WHERE project_key = ? AND task_group = ? AND id = ?`,
      t, truncated ? `${result.slice(0, MAX_RESULT_SIZE)}\n...[truncated]` : result, result.length, elapsed,
      input.project, task.task_group as string, task.id as string,
    );
    return {
      task_id: task.id,
      task_group: task.task_group,
      status: "completed",
      remaining_tasks: this.remaining(input.project, task.task_group as string),
      truncated,
    };
  }

  failTask(input: { project: string; task_id: string; task_group?: string | null; error: string }) {
    const task = this.findTask(input.project, input.task_id, input.task_group);
    this.db.run(
      "UPDATE tasks SET status = 'failed', completed_at = ?, error = ? WHERE project_key = ? AND task_group = ? AND id = ?",
      this.clock(), required(input.error, "error"), input.project, task.task_group as string, task.id as string,
    );
    return {
      task_id: task.id,
      task_group: task.task_group,
      status: "failed",
      remaining_tasks: this.remaining(input.project, task.task_group as string),
    };
  }

  taskStatus(input: { project: string; task_group?: string | null; task_id?: string | null; branch?: string | null }) {
    if (input.task_id) {
      const task = this.findTask(input.project, input.task_id, input.task_group);
      return { task };
    }
    const group = this.groupOrLatest(input.project, input.task_group, input.branch);
    const tasks = this.db.all(
      `SELECT id, title, status, started_at, completed_at, execution_time_ms, result_size, error
       FROM tasks WHERE project_key = ? AND task_group = ? ORDER BY index_num`,
      input.project, group,
    );
    return { task_group: group, tasks };
  }

  taskSummary(project: string, taskGroup?: string | null) {
    const group = this.groupOrLatest(project, taskGroup);
    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of this.db.all<{ status: string; n: number }>(
      "SELECT status, COUNT(*) AS n FROM tasks WHERE project_key = ? AND task_group = ? GROUP BY status",
      project, group,
    )) {
      counts[r.status] = r.n;
      total += r.n;
    }
    const time = this.db.get<{ ms: number }>(
      "SELECT COALESCE(SUM(execution_time_ms), 0) AS ms FROM tasks WHERE project_key = ? AND task_group = ?",
      project, group,
    );
    return {
      task_group: group,
      total,
      pending: counts.pending ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      total_execution_time_ms: time?.ms ?? 0,
    };
  }

  taskResult(input: { project: string; task_id: string; task_group?: string | null }) {
    const t = this.findTask(input.project, input.task_id, input.task_group);
    return { task_id: t.id, task_group: t.task_group, title: t.title, status: t.status, result: t.result, error: t.error };
  }

  /**
   * The newest task group. With a branch (or null for a detached HEAD) only groups made on that
   * branch, or on none, count, so two worktrees on different branches never share a task loop.
   * `undefined` means no branch filter.
   */
  latestGroup(project: string, branch?: string | null): string | null {
    const values: SqlValue[] = [project];
    let filter = "";
    if (branch !== undefined) {
      filter = branch === null ? " AND branch IS NULL" : " AND (branch = ? OR branch IS NULL)";
      if (branch !== null) values.push(branch);
    }
    const row = this.db.get<{ task_group: string }>(
      `SELECT task_group FROM tasks WHERE project_key = ?${filter}
       GROUP BY task_group ORDER BY MAX(created_at) DESC, MAX(rowid) DESC LIMIT 1`,
      ...values,
    );
    return row?.task_group ?? null;
  }

  listTaskGroups(project: string) {
    return this.db.all(
      `SELECT task_group, COUNT(*) AS total,
              SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed,
              SUM(status = 'pending') AS pending, SUM(status = 'running') AS running,
              MIN(created_at) AS created_at, MIN(branch) AS branch
       FROM tasks WHERE project_key = ? GROUP BY task_group ORDER BY MAX(created_at) DESC, MAX(rowid) DESC`,
      project,
    );
  }

  clearTasks(input: { project: string; task_group?: string | null }) {
    const project = required(input.project, "project");
    const before = this.db.get<{ n: number }>(
      input.task_group
        ? "SELECT COUNT(*) AS n FROM tasks WHERE project_key = ? AND task_group = ?"
        : "SELECT COUNT(*) AS n FROM tasks WHERE project_key = ?",
      ...(input.task_group ? [project, input.task_group] : [project]),
    );
    if (input.task_group) {
      this.db.run("DELETE FROM tasks WHERE project_key = ? AND task_group = ?", project, input.task_group);
    } else {
      this.db.run("DELETE FROM tasks WHERE project_key = ?", project);
    }
    return { cleared: before?.n ?? 0, task_group: input.task_group ?? null };
  }

  // ─── Export / import ───────────────────────────────────

  exportAll(project?: string | null): ExportData {
    const tables: Record<string, Row[]> = {};
    const scoped = (col: string, join = "") => (project ? ` ${join} WHERE ${col} = ?` : "");
    const args: SqlValue[] = project ? [project] : [];
    const cols = (table: string, alias: string) => EXPORT_COLUMNS[table].map((c) => `${alias}.${c}`).join(", ");

    tables.projects = this.db.all(`SELECT ${cols("projects", "p")} FROM projects p${scoped("p.key")}`, ...args);
    tables.project_paths = this.db.all(
      `SELECT ${cols("project_paths", "x")} FROM project_paths x${scoped("x.project_key")}`,
      ...args,
    );
    tables.entries = this.db.all(`SELECT ${cols("entries", "x")} FROM entries x${scoped("x.project_key")}`, ...args);
    tables.entities = this.db.all(`SELECT ${cols("entities", "x")} FROM entities x${scoped("x.project_key")}`, ...args);
    tables.observations = this.db.all(
      `SELECT ${cols("observations", "o")} FROM observations o JOIN entities x ON x.id = o.entity_id${scoped("x.project_key")}`,
      ...args,
    );
    tables.relations = this.db.all(
      `SELECT ${cols("relations", "r")} FROM relations r JOIN entities x ON x.id = r.source_id${scoped("x.project_key")}`,
      ...args,
    );
    tables.tasks = this.db.all(`SELECT ${cols("tasks", "x")} FROM tasks x${scoped("x.project_key")}`, ...args);

    return { format: "task-runner-export", version: 1, exported_at: this.clock(), tables };
  }

  importAll(data: ExportData) {
    if (data?.format !== "task-runner-export" || data.version !== 1) {
      throw new StoreError("invalid", "Not a task-runner export (format/version mismatch)");
    }
    const counts: Record<string, number> = {};
    this.db.transaction(() => {
      for (const table of Object.keys(EXPORT_COLUMNS)) {
        const cols = EXPORT_COLUMNS[table];
        const sql = `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
        let n = 0;
        for (const row of data.tables?.[table] ?? []) {
          this.db.run(sql, ...cols.map((c) => (row[c] ?? null) as SqlValue));
          n++;
        }
        counts[table] = n;
      }
      this.reindexAll();
    });
    return { imported: counts };
  }

  reindexAll() {
    this.db.transaction(() => {
      this.db.run("DELETE FROM entries_fts");
      this.db.run("DELETE FROM entities_fts");
      this.db.run(
        `INSERT INTO entries_fts(rowid, title, content, tags)
         SELECT seq, ${foldSql("title")}, ${foldSql("content")}, ${foldSql("COALESCE(tags, '')")} FROM entries`,
      );
      for (const e of this.db.all<{ id: string }>("SELECT id FROM entities WHERE valid_until IS NULL")) {
        this.indexEntity(e.id);
      }
    });
  }

  // ─── Internals ─────────────────────────────────────────

  private indexEntry(id: string): void {
    const row = this.db.get<{ seq: number }>("SELECT seq FROM entries WHERE id = ?", id);
    if (!row) return;
    this.db.run("DELETE FROM entries_fts WHERE rowid = ?", row.seq);
    this.db.run(
      `INSERT INTO entries_fts(rowid, title, content, tags)
       SELECT seq, ${foldSql("title")}, ${foldSql("content")}, ${foldSql("COALESCE(tags, '')")} FROM entries WHERE seq = ?`,
      row.seq,
    );
  }

  private indexEntity(id: string): void {
    const e = this.db.get<{ seq: number; name: string; summary: string | null; valid_until: number | null }>(
      "SELECT seq, name, summary, valid_until FROM entities WHERE id = ?",
      id,
    );
    if (!e) return;
    this.db.run("DELETE FROM entities_fts WHERE rowid = ?", e.seq);
    if (e.valid_until !== null) return;
    const facts = this.db.get<{ facts: string | null }>(
      "SELECT group_concat(content, char(10)) AS facts FROM observations WHERE entity_id = ? AND valid_until IS NULL",
      id,
    );
    this.db.run(
      "INSERT INTO entities_fts(rowid, name, summary, facts) VALUES (?, ?, ?, ?)",
      e.seq, fold(e.name), fold(e.summary ?? ""), fold(facts?.facts ?? ""),
    );
  }

  private linkSuggestions(project: string, entityId: string, texts: string[]): string[] {
    const haystack = texts.join(" \n ").toLowerCase();
    if (haystack.trim().length < 4) return [];
    const linked = new Set(
      this.db
        .all<{ other: string }>(
          `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS other
           FROM relations WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL`,
          entityId, entityId, entityId,
        )
        .map((r) => r.other),
    );
    const out: string[] = [];
    for (const e of this.db.all<{ id: string; name: string }>(
      "SELECT id, name FROM entities WHERE project_key IN (?, ?) AND valid_until IS NULL AND id <> ? ORDER BY importance DESC LIMIT 500",
      project, GLOBAL_PROJECT, entityId,
    )) {
      const needle = e.name.toLowerCase();
      if (needle.length < 3 || linked.has(e.id)) continue;
      const at = haystack.indexOf(needle);
      if (at < 0) continue;
      const before = haystack[at - 1];
      const after = haystack[at + needle.length];
      const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
      if (isWord(before) || isWord(after)) continue;
      out.push(e.name);
      if (out.length === 3) break;
    }
    return out;
  }

  private similarEntities(project: string, name: string, excludeId: string): Array<{ name: string; entity_type: string }> {
    const match = ftsQuery(name);
    if (!match) return [];
    return this.db.all<{ name: string; entity_type: string }>(
      `SELECT e.name, e.entity_type
       FROM entities_fts JOIN entities e ON e.seq = entities_fts.rowid
       WHERE entities_fts MATCH ? AND e.project_key IN (?, ?) AND e.valid_until IS NULL AND e.id <> ?
       ORDER BY bm25(entities_fts, 8.0, 3.0, 0.0) LIMIT 3`,
      match, project, GLOBAL_PROJECT, excludeId,
    );
  }

  private insertFacts(entityId: string, facts: string[]): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of facts) {
      const fact = raw.trim();
      if (fact.length > MAX_FACT_LENGTH) {
        throw new StoreError(
          "invalid",
          `A fact is ${fact.length} characters; the limit is ${MAX_FACT_LENGTH}. Split it into atomic facts, or use save_memory for long notes.`,
        );
      }
      if (!fact || seen.has(fact.toLowerCase())) continue;
      seen.add(fact.toLowerCase());
      const dup = this.db.get(
        "SELECT 1 FROM observations WHERE entity_id = ? AND valid_until IS NULL AND content = ? COLLATE NOCASE",
        entityId, fact,
      );
      if (dup) continue;
      const id = newId("obs");
      this.db.run("INSERT INTO observations (id, entity_id, content, created_at) VALUES (?, ?, ?, ?)", id, entityId, fact, this.clock());
      ids.push(id);
    }
    return ids;
  }

  private facts(entityId: string, limit: number): Row[] {
    return this.db.all(
      "SELECT id, content, confidence, created_at FROM observations WHERE entity_id = ? AND valid_until IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
      entityId, limit,
    );
  }

  private bumpAccess(ids: string[]): void {
    const t = this.clock();
    for (const id of ids) {
      this.db.run("UPDATE entities SET access_count = access_count + 1, last_accessed = ? WHERE id = ?", t, id);
    }
  }

  private resolveEntity(project: string, name: string, type?: string): Row & { id: string; name: string; entity_type: string } {
    required(project, "project");
    required(name, "name");
    let typeFilter = "";
    const typeValues: SqlValue[] = [];
    if (type) {
      typeFilter = " AND entity_type = ?";
      typeValues.push(assertIn(type, ENTITY_TYPES, "entity_type"));
    }
    const lookup = (scope: string) =>
      this.db.all<Row & { id: string; name: string; entity_type: string }>(
        `SELECT ${ENTITY_COLS} FROM entities WHERE project_key = ? AND name = ? COLLATE NOCASE AND valid_until IS NULL${typeFilter}`,
        scope, name.trim(), ...typeValues,
      );
    let rows = lookup(project);
    if (rows.length === 0 && project !== GLOBAL_PROJECT) rows = lookup(GLOBAL_PROJECT);
    if (rows.length === 0) throw new StoreError("not_found", `Entity '${name}' not found`);
    if (rows.length > 1) {
      throw new StoreError(
        "invalid",
        `Entity '${name}' is ambiguous. Pass entity_type (${rows.map((r) => r.entity_type).join(", ")}).`,
      );
    }
    return rows[0];
  }

  private groupOrLatest(project: string, group?: string | null, branch?: string | null): string {
    if (group) return group;
    const latest = this.latestGroup(project, branch);
    if (!latest) throw new StoreError("not_found", "No task groups found. Call create_task_group first.");
    return latest;
  }

  private findTask(project: string, taskId: string, group?: string | null): Row {
    required(taskId, "task_id");
    const values: SqlValue[] = [project, taskId];
    let groupFilter = "";
    if (group) {
      groupFilter = " AND task_group = ?";
      values.push(group);
    }
    const task = this.db.get<Row>(
      `SELECT * FROM tasks WHERE project_key = ? AND id = ?${groupFilter}
       ORDER BY (status = 'running') DESC, created_at DESC, rowid DESC LIMIT 1`,
      ...values,
    );
    if (!task) throw new StoreError("not_found", `Task '${taskId}' not found`);
    return task;
  }

  private remaining(project: string, group: string): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_key = ? AND task_group = ? AND status IN ('pending', 'running')",
        project, group,
      )?.n ?? 0
    );
  }
}
