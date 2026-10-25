import type { Db } from "./db.ts";

const FTS_TOKENIZER = "porter unicode61 remove_diacritics 2";
// Porter stems English only and disagrees with prefix queries ("deploy" becomes "deploi"), so v4 drops it
// and the query side adds its own short stems instead.
const FTS_TOKENIZER_V4 = "unicode61 remove_diacritics 2";

const migrations: Array<(db: Db) => void> = [
  (db) => {
    db.exec(`
      CREATE TABLE projects (
        key TEXT PRIMARY KEY,
        project_path TEXT,
        project_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_projects_path ON projects(project_path);

      CREATE TABLE entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
        scope TEXT NOT NULL DEFAULT 'project',
        scope_ref TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_entries_project ON entries(project_key, scope, scope_ref);
      CREATE INDEX idx_entries_created ON entries(project_key, created_at DESC);

      CREATE TABLE entities (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        summary TEXT,
        properties TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        valid_until INTEGER,
        UNIQUE (project_key, name, entity_type)
      );
      CREATE INDEX idx_entities_project ON entities(project_key, entity_type);

      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'agent',
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        valid_until INTEGER,
        superseded_by TEXT
      );
      CREATE INDEX idx_observations_entity ON observations(entity_id);

      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        context TEXT,
        created_at INTEGER NOT NULL,
        valid_until INTEGER,
        UNIQUE (source_id, target_id, relation_type)
      );
      CREATE INDEX idx_relations_source ON relations(source_id);
      CREATE INDEX idx_relations_target ON relations(target_id);

      CREATE TABLE tasks (
        project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
        task_group TEXT NOT NULL,
        id TEXT NOT NULL,
        index_num INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        error TEXT,
        system_prompt TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        execution_time_ms INTEGER,
        result_size INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_key, task_group, id)
      );
      CREATE INDEX idx_tasks_status ON tasks(project_key, task_group, status, index_num);

      CREATE VIRTUAL TABLE entries_fts USING fts5(
        title, content, tags,
        tokenize = '${FTS_TOKENIZER}'
      );
      CREATE VIRTUAL TABLE entities_fts USING fts5(
        name, summary, facts,
        tokenize = '${FTS_TOKENIZER}'
      );
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN branch TEXT;

      CREATE TABLE project_paths (
        path TEXT PRIMARY KEY,
        project_key TEXT NOT NULL REFERENCES projects(key) ON DELETE CASCADE,
        seen_at INTEGER NOT NULL
      );
      CREATE INDEX idx_project_paths_project ON project_paths(project_key);
      INSERT OR IGNORE INTO project_paths (path, project_key, seen_at)
        SELECT project_path, key, updated_at FROM projects WHERE project_path IS NOT NULL;
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE worklog_files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL
      );

      CREATE TABLE worklog_minutes (
        file TEXT NOT NULL REFERENCES worklog_files(path) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        minute INTEGER NOT NULL,
        kind TEXT NOT NULL,
        project_key TEXT NOT NULL,
        branch TEXT NOT NULL,
        secs INTEGER NOT NULL,
        PRIMARY KEY (file, minute, kind, project_key, branch)
      );
      CREATE INDEX idx_worklog_minutes_range ON worklog_minutes(minute, project_key, branch);

      CREATE TABLE worklog_facts (
        file TEXT NOT NULL REFERENCES worklog_files(path) ON DELETE CASCADE,
        day TEXT NOT NULL,
        project_key TEXT NOT NULL,
        branch TEXT NOT NULL,
        prompts INTEGER NOT NULL,
        edits INTEGER NOT NULL,
        first_prompt TEXT,
        PRIMARY KEY (file, day, project_key, branch)
      );

      CREATE TABLE worklog_exports (
        project_key TEXT NOT NULL,
        branch TEXT NOT NULL,
        target TEXT NOT NULL,
        through_minute INTEGER NOT NULL,
        exported_at INTEGER NOT NULL,
        PRIMARY KEY (project_key, branch, target)
      );
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE entities ADD COLUMN keywords TEXT;
      DROP TABLE entities_fts;
      CREATE VIRTUAL TABLE entities_fts USING fts5(
        name, keywords, summary, facts,
        tokenize = '${FTS_TOKENIZER_V4}'
      );
      DROP TABLE entries_fts;
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        title, content, tags,
        tokenize = '${FTS_TOKENIZER_V4}'
      );
    `);
    // The trigram index is a fallback for word parts and typos; older SQLite builds lack it.
    for (const tokenizer of ["trigram remove_diacritics 1", "trigram"]) {
      try {
        db.exec(`CREATE VIRTUAL TABLE entities_tri USING fts5(body, tokenize = '${tokenizer}')`);
        break;
      } catch {
        // try the next form
      }
    }
    db.run(
      "INSERT INTO schema_meta (key, value) VALUES ('reindex', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
  },
];

export const SCHEMA_VERSION = migrations.length;

export function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'");
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema v${current} is newer than this build supports (v${SCHEMA_VERSION}). Update task-runner-mcp.`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      migrations[v](db);
      db.run(
        "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(v + 1),
      );
    });
  }
}
