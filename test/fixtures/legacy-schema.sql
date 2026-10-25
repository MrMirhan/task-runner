-- Schema of the hosted Worker before 1.0 (TaskRunnerStorage.ensureTables), for the upgrade test.
      CREATE TABLE IF NOT EXISTS projects (
        key TEXT PRIMARY KEY,
        project_path TEXT,
        project_name TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        scope_ref TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        session_id TEXT,
        FOREIGN KEY (project_key) REFERENCES projects(key)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        task_group TEXT NOT NULL,
        index_num INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        result TEXT,
        error TEXT,
        system_prompt TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        execution_time_ms INTEGER,
        result_size INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (project_key) REFERENCES projects(key)
      );

      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_key);
      CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(project_key, scope, scope_ref);
      CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_key, task_group);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_key, status);
    
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        summary TEXT,
        properties TEXT,
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER DEFAULT (unixepoch()),
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        valid_until INTEGER,
        FOREIGN KEY (project_key) REFERENCES projects(key),
        UNIQUE(project_key, name, entity_type)
      );

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT DEFAULT 'agent',
        confidence REAL DEFAULT 1.0,
        valid_from INTEGER DEFAULT (unixepoch()),
        valid_until INTEGER,
        superseded_by TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        context TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        valid_until INTEGER,
        FOREIGN KEY (source_id) REFERENCES entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES entities(id) ON DELETE CASCADE,
        UNIQUE(source_id, target_id, relation_type)
      );

      CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_key);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(project_key, entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
      CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
    
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        title, content, tags,
        content='entries', content_rowid='rowid',
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name, summary,
        content='entities', content_rowid='rowid',
        tokenize='porter unicode61'
      );
    
      CREATE TRIGGER IF NOT EXISTS entries_fts_ins AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, COALESCE(new.tags, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS entries_fts_del AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, COALESCE(old.tags, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_ins AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, summary) VALUES (new.rowid, new.name, COALESCE(new.summary, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS entities_fts_del AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, summary) VALUES ('delete', old.rowid, old.name, COALESCE(old.summary, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS entities_fts_upd AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, summary) VALUES ('delete', old.rowid, old.name, COALESCE(old.summary, ''));
        INSERT INTO entities_fts(rowid, name, summary) VALUES (new.rowid, new.name, COALESCE(new.summary, ''));
      END;
    
