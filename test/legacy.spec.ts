import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Store } from "../src/core/store.ts";
import { openDb } from "../src/node/sqlite.ts";

const LEGACY_SQL = readFileSync(new URL("./fixtures/legacy-schema.sql", import.meta.url), "utf8");

function legacyDb() {
  const db = openDb(":memory:");
  db.exec(LEGACY_SQL);
  // Durable Objects enforce foreign keys too; turning them off here only lets the test plant an orphan row.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO projects (key, project_path, project_name) VALUES ('extranet', '/work/extranet', 'extranet');
    INSERT INTO entries (id, project_key, scope, type, title, content, tags, created_at)
      VALUES ('e1', 'extranet', 'project', 'decision', 'Use Hikari', 'Pool size stays at 10 for staging', 'db', 1700000000);
    INSERT INTO entries (id, project_key, type, title, content) VALUES ('e2', 'orphan-project', 'note', 'Loose note', 'No project row');
    INSERT INTO entities (id, project_key, name, entity_type, summary, importance)
      VALUES ('n1', 'extranet', 'payments-service', 'component', 'Handles Stripe webhooks', 0.9);
    INSERT INTO entities (id, project_key, name, entity_type) VALUES ('n2', 'extranet', 'redis', 'technology');
    INSERT INTO observations (id, entity_id, content, valid_from) VALUES ('o1', 'n1', 'Retries webhooks three times', 1700000100);
    INSERT INTO observations (id, entity_id, content) VALUES ('o2', 'n2', 'Used for idempotency keys');
    INSERT INTO relations (id, source_id, target_id, relation_type) VALUES ('r1', 'n1', 'n2', 'depends_on');
    INSERT INTO tasks (id, project_key, task_group, index_num, title, content, status, result)
      VALUES ('t1', 'extranet', 'migration', 0, 'Copy rows', 'Copy every row', 'completed', 'done');
  `);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

test("a database from the hosted server before 1.0 is upgraded in place without losing rows", () => {
  const db = legacyDb();
  const store = new Store(db);

  assert.deepEqual(
    store.listProjects().map((p) => p.key).sort(),
    ["extranet", "orphan-project"],
  );
  assert.equal(store.findProjectByPath("/work/extranet"), "extranet");

  const entries = store.getContext({ project: "extranet", all: true }) as unknown as { entries: Array<{ title: string }> };
  assert.deepEqual(entries.entries.map((e) => e.title), ["Use Hikari"]);
  assert.equal((store.getContext({ project: "orphan-project", all: true }) as { entries: unknown[] }).entries.length, 1);

  // The search index is rebuilt for the copied rows.
  const found = JSON.stringify(store.recall({ project: "extranet", q: "stripe webhooks" }));
  assert.match(found, /payments-service/);
  assert.match(found, /Retries webhooks three times/);
  assert.match(JSON.stringify(store.searchEntries({ project: "extranet", q: "hikari pool" })), /Use Hikari/);

  const stats = store.graphStats("extranet");
  assert.equal(stats.entities, 2);
  assert.equal(stats.relations, 1);
  assert.equal(stats.observations, 2);
  assert.match(JSON.stringify(store.taskResult({ project: "extranet", task_group: "migration", task_id: "t1" })), /done/);

  // The old tables stay as a backup.
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM legacy_entries")?.n, 2);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM legacy_observations")?.n, 2);
});

test("the upgrade runs once: reopening keeps new writes and copies nothing twice", () => {
  const db = legacyDb();
  new Store(db).saveEntry({ project: "extranet", type: "note", title: "After upgrade", content: "Written by 1.0" });
  const again = new Store(db);
  const titles = (again.getContext({ project: "extranet", all: true }) as unknown as { entries: Array<{ title: string }> }).entries.map((e) => e.title);
  assert.deepEqual(titles.sort(), ["After upgrade", "Use Hikari"]);
  assert.equal(again.graphStats("extranet").entities, 2);
});
