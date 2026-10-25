import assert from "node:assert/strict";
import { test } from "node:test";
import { StoreError } from "../src/core/errors.ts";
import { memoryStore } from "./helpers.ts";

const P = "acme-web";

test("setContext reports other projects that share the path", () => {
  const { store } = memoryStore();
  store.setContext({ project: "old-key", project_path: "/work/acme" });
  const next = store.setContext({ project: "new-key", project_path: "/work/acme" });
  assert.equal(next.created, true);
  assert.deepEqual(next.same_path_projects, ["old-key"]);
  assert.equal(store.findProjectByPath("/work/acme"), "new-key");
});

test("entries are searchable and reindexed after an update", () => {
  const { store } = memoryStore();
  const saved = store.saveEntry({ project: P, type: "decision", title: "Use SQLite", content: "Single file, no server" });
  assert.equal(store.searchEntries({ q: "sqlite", project: P }).count, 1);

  store.updateEntry({ id: saved.id, content: "Postgres was too heavy" });
  assert.equal(store.searchEntries({ q: "single", project: P }).count, 0);
  assert.equal(store.searchEntries({ q: "postgres", project: P }).count, 1);

  store.deleteEntry(saved.id);
  assert.equal(store.searchEntries({ q: "sqlite", project: P }).count, 0);
});

test("branch notes only appear on their branch", () => {
  const { store } = memoryStore();
  store.saveEntry({ project: P, type: "note", title: "project wide", content: "a" });
  store.saveEntry({ project: P, type: "note", title: "on feat", content: "b", scope: "branch", scope_ref: "feat/x" });
  assert.equal(store.getContext({ project: P }).count, 1);
  assert.equal(store.getContext({ project: P, branch: "feat/x" }).count, 2);
  assert.equal(store.getContext({ project: P, all: true }).count, 2);
  assert.throws(() => store.saveEntry({ project: P, type: "note", title: "t", content: "c", scope: "pr" }), StoreError);
});

test("recall finds facts inside observations, not only names", () => {
  const { store } = memoryStore();
  store.upsertEntity({
    project: P, name: "Deploy", entity_type: "pattern",
    observations: ["Always run migrations before restarting the worker"],
  });
  const found = store.recall({ project: P, q: "migrations" });
  assert.equal(found.entities.length, 1);
  assert.equal(found.entities[0].name, "Deploy");
});

test("recall matches Turkish text without diacritics and by prefix", () => {
  const { store } = memoryStore();
  store.upsertEntity({
    project: P, name: "Çalışma düzeni", entity_type: "convention",
    observations: ["Yanıtlar Türkçe yazılır"],
  });
  assert.equal(store.recall({ project: P, q: "calisma" }).entities.length, 1);
  assert.equal(store.recall({ project: P, q: "turkce" }).entities.length, 1);
  assert.equal(store.recall({ project: P, q: "yanit" }).entities.length, 1);
});

test("recall never throws on FTS syntax characters", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Redis", entity_type: "tool" });
  for (const q of ['"', "AND OR NOT", "foo*(", "a:b", "-", "''", "NEAR(", "тест"]) {
    assert.doesNotThrow(() => store.recall({ project: P, q }));
  }
});

test("upsert is case-insensitive, merges facts and skips duplicates", () => {
  const { store } = memoryStore();
  const first = store.upsertEntity({ project: P, name: "Zustand", entity_type: "tool", observations: ["small"] });
  const again = store.upsertEntity({ project: P, name: "zustand", entity_type: "tool", observations: ["SMALL", "fast"] });
  assert.equal(again.is_new, false);
  assert.equal(again.entity_id, first.entity_id);
  assert.equal(again.observations_added, 1);
  assert.equal(store.getEntity({ project: P, name: "ZUSTAND" }).observations.length, 2);
});

test("a new entity reports similar existing ones", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Redis cache", entity_type: "tool" });
  const second = store.upsertEntity({ project: P, name: "Redis caching layer", entity_type: "pattern" });
  assert.deepEqual(second.similar_existing?.map((r) => ({ ...r })), [{ name: "Redis cache", entity_type: "tool" }]);
});

test("default importance follows the entity type", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Never force push", entity_type: "pitfall" });
  store.upsertEntity({ project: P, name: "src/app.ts", entity_type: "file" });
  const hits = store.recall({ project: P, q: "force" }).entities;
  assert.equal(hits[0].importance, 0.8);
  assert.equal(store.getEntity({ project: P, name: "src/app.ts" }).entity.importance, 0.4);
});

test("facts over the length limit are rejected", () => {
  const { store } = memoryStore();
  assert.throws(
    () => store.upsertEntity({ project: P, name: "Blob", entity_type: "concept", observations: ["x".repeat(1001)] }),
    /Split it into atomic facts/,
  );
});

test("correct_fact replaces a fact and the old text stops matching", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "API", entity_type: "concept", observations: ["Rate limit is 100 per minute"] });
  const [old] = store.getEntity({ project: P, name: "API" }).observations;
  store.correctFact({ project: P, observation_id: old.id as string, new_fact: "Rate limit is 500 per minute" });

  const facts = store.getEntity({ project: P, name: "API" }).observations.map((o) => o.content);
  assert.deepEqual(facts, ["Rate limit is 500 per minute"]);
  assert.equal(store.recall({ project: P, q: "100" }).entities.length, 0);
  assert.equal(store.recall({ project: P, q: "500" }).entities.length, 1);

  assert.throws(() => store.correctFact({ project: P, observation_id: old.id as string }), /not found/);
});

test("link needs a type only when the name is ambiguous", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Auth", entity_type: "concept" });
  store.upsertEntity({ project: P, name: "Auth", entity_type: "pattern" });
  store.upsertEntity({ project: P, name: "JWT", entity_type: "tool" });

  assert.throws(() => store.link({ project: P, from_name: "Auth", to_name: "JWT", relation_type: "uses" }), /ambiguous/);
  const linked = store.link({ project: P, from_name: "Auth", from_type: "pattern", to_name: "jwt", relation_type: "uses" });
  assert.equal(linked.is_new, true);
  assert.equal(store.link({ project: P, from_name: "Auth", from_type: "pattern", to_name: "JWT", relation_type: "uses" }).is_new, false);
  assert.throws(() => store.link({ project: P, from_name: "JWT", to_name: "JWT", relation_type: "uses" }), /itself/);
});

test("neighbours walk up to the requested hops without cycles", () => {
  const { store } = memoryStore();
  for (const n of ["A", "B", "C", "D"]) store.upsertEntity({ project: P, name: n, entity_type: "concept" });
  store.link({ project: P, from_name: "A", to_name: "B", relation_type: "relates_to" });
  store.link({ project: P, from_name: "B", to_name: "C", relation_type: "relates_to" });
  store.link({ project: P, from_name: "C", to_name: "A", relation_type: "relates_to" });
  store.link({ project: P, from_name: "C", to_name: "D", relation_type: "relates_to" });

  const a = store.getEntity({ project: P, name: "A" }).entity.id as string;
  const one = store.neighbors(a, 1).map((n) => n.name).sort();
  const two = store.neighbors(a, 2).map((n) => n.name).sort();
  assert.deepEqual(one, ["B", "C"]);
  assert.deepEqual(two, ["B", "C", "D"]);
});

test("forget hides an entity everywhere and upsert revives it", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Legacy", entity_type: "pattern", observations: ["old way"] });
  store.upsertEntity({ project: P, name: "Modern", entity_type: "pattern" });
  store.link({ project: P, from_name: "Modern", to_name: "Legacy", relation_type: "supersedes" });

  store.forget({ project: P, name: "Legacy" });
  assert.equal(store.recall({ project: P, q: "legacy" }).entities.length, 0);
  assert.equal(store.graphAll(P).relation_count, 0);
  assert.throws(() => store.getEntity({ project: P, name: "Legacy" }), /not found/);

  store.upsertEntity({ project: P, name: "Legacy", entity_type: "pattern" });
  assert.equal(store.recall({ project: P, q: "legacy" }).entities.length, 1);
});

test("global facts surface in every project and resolve by name", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: "_global", name: "Language", entity_type: "preference", observations: ["Reply in Turkish"] });

  const found = store.recall({ project: "other-app", q: "turkish" });
  assert.equal(found.entities.length, 1);
  assert.equal(found.entities[0].project_key, "_global");
  assert.doesNotThrow(() => store.addFacts({ project: "other-app", entity_name: "Language", facts: ["Keep code in English"] }));
  assert.equal(store.digest("other-app").global_entities.length, 1);
});

test("graph stats count orphans", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "A", entity_type: "concept", observations: ["x"] });
  store.upsertEntity({ project: P, name: "B", entity_type: "concept" });
  store.upsertEntity({ project: P, name: "C", entity_type: "concept" });
  store.link({ project: P, from_name: "A", to_name: "B", relation_type: "relates_to" });
  const stats = store.graphStats(P);
  assert.equal(stats.entities, 3);
  assert.equal(stats.relations, 1);
  assert.equal(stats.orphan_entities, 1);
  assert.equal(stats.observations, 1);
});

test("task groups keep independent ids", () => {
  const { store } = memoryStore();
  const tasks = [{ title: "one", content: "do one" }, { title: "two", content: "do two" }];
  store.createTasks({ project: P, task_group: "alpha", tasks });
  store.createTasks({ project: P, task_group: "beta", tasks });
  store.createTasks({ project: "other", task_group: "alpha", tasks });

  const next = store.nextTask({ project: P, task_group: "alpha" });
  assert.equal(next.done, false);
  store.completeTask({ project: P, task_group: "alpha", task_id: "task-001", result: "ok" });

  assert.equal(store.taskSummary(P, "alpha").completed, 1);
  assert.equal(store.taskSummary(P, "beta").completed, 0);
});

test("the task loop runs to completion and measures time itself", () => {
  const { store, tick } = memoryStore();
  store.createTasks({
    project: P, task_group: "g", system_prompt: "be careful",
    tasks: [{ title: "a", content: "A" }, { title: "b", content: "B" }],
  });

  const a = store.nextTask({ project: P });
  assert.equal(a.done, false);
  assert.equal((a as { task: { system_prompt: string } }).task.system_prompt, "be careful");
  tick(12);
  const doneA = store.completeTask({ project: P, task_id: "task-001", result: "A done" });
  assert.equal(doneA.remaining_tasks, 1);

  store.nextTask({ project: P });
  const failed = store.failTask({ project: P, task_id: "task-002", error: "boom" });
  assert.equal(failed.remaining_tasks, 0);

  const end = store.nextTask({ project: P });
  assert.equal(end.done, true);

  const summary = store.taskSummary(P, "g");
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.total_execution_time_ms, 12_000);
  assert.equal(store.taskResult({ project: P, task_id: "task-002" }).error, "boom");
});

test("a task running for over 30 minutes is offered again", () => {
  const { store, tick } = memoryStore();
  store.createTasks({ project: P, task_group: "g", tasks: [{ title: "a", content: "A" }] });
  store.nextTask({ project: P });
  assert.equal(store.nextTask({ project: P }).done, true);
  tick(31 * 60);
  const again = store.nextTask({ project: P });
  assert.equal(again.done, false);
});

test("recreating a group with progress needs replace", () => {
  const { store } = memoryStore();
  const tasks = [{ title: "a", content: "A" }];
  store.createTasks({ project: P, task_group: "g", tasks });
  store.nextTask({ project: P });
  assert.throws(() => store.createTasks({ project: P, task_group: "g", tasks }), /replace/);
  assert.doesNotThrow(() => store.createTasks({ project: P, task_group: "g", tasks, replace: true }));
});

test("large results are truncated but their size is recorded", () => {
  const { store } = memoryStore();
  store.createTasks({ project: P, task_group: "g", tasks: [{ title: "a", content: "A" }] });
  store.nextTask({ project: P });
  const done = store.completeTask({ project: P, task_id: "task-001", result: "x".repeat(60_000) });
  assert.equal(done.truncated, true);
  const stored = store.taskResult({ project: P, task_id: "task-001" }).result as string;
  assert.ok(stored.endsWith("...[truncated]"));
});

test("clearTasks leaves memory alone", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Keep", entity_type: "concept" });
  store.createTasks({ project: P, task_group: "g", tasks: [{ title: "a", content: "A" }] });
  assert.equal(store.clearTasks({ project: P }).cleared, 1);
  assert.equal(store.graphStats(P).entities, 1);
});

test("deleteProject removes everything including search rows", () => {
  const { store, db } = memoryStore();
  store.upsertEntity({ project: P, name: "Thing", entity_type: "concept", observations: ["findable"] });
  store.saveEntry({ project: P, type: "note", title: "findable note", content: "findable" });
  store.deleteProject(P);
  assert.equal(store.listProjects().length, 0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entities_fts")?.n, 0);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entries_fts")?.n, 0);
});

test("export then import into a fresh database restores search", () => {
  const source = memoryStore();
  source.store.setContext({ project: P, project_path: "/w" });
  source.store.upsertEntity({ project: P, name: "Cache", entity_type: "pattern", observations: ["invalidate on write"] });
  source.store.upsertEntity({ project: P, name: "Redis", entity_type: "tool" });
  source.store.link({ project: P, from_name: "Cache", to_name: "Redis", relation_type: "uses" });
  source.store.saveEntry({ project: P, type: "decision", title: "Cache it", content: "because latency" });
  source.store.createTasks({ project: P, task_group: "g", tasks: [{ title: "a", content: "A" }] });

  const dump = JSON.parse(JSON.stringify(source.store.exportAll()));
  const target = memoryStore();
  target.store.importAll(dump);

  assert.equal(target.store.recall({ project: P, q: "invalidate" }).entities.length, 1);
  assert.equal(target.store.searchEntries({ q: "latency" }).count, 1);
  assert.equal(target.store.graphAll(P).relation_count, 1);
  assert.equal(target.store.taskSummary(P, "g").pending, 1);
  assert.equal(target.store.importAll(dump).imported.entities, 2);
  assert.equal(target.store.graphStats(P).entities, 2);
});

test("a newer schema version is refused", async () => {
  const { db } = memoryStore();
  db.run("UPDATE schema_meta SET value = '99' WHERE key = 'version'");
  const { Store } = await import("../src/core/store.ts");
  assert.throws(() => new Store(db), /newer than this build/);
});

test("mergeProjects folds entities, facts, relations, notes and tasks into one key", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: "old", name: "Cache", entity_type: "pattern", observations: ["shared", "only old"] });
  store.upsertEntity({ project: "old", name: "Redis", entity_type: "tool" });
  store.link({ project: "old", from_name: "Cache", to_name: "Redis", relation_type: "uses" });
  store.upsertEntity({ project: "old", name: "Unique", entity_type: "concept" });
  store.saveEntry({ project: "old", type: "note", title: "old note", content: "from old" });
  store.createTasks({ project: "old", task_group: "g", tasks: [{ title: "a", content: "A" }] });

  store.upsertEntity({ project: "new", name: "cache", entity_type: "pattern", observations: ["shared", "only new"] });
  store.createTasks({ project: "new", task_group: "g", tasks: [{ title: "b", content: "B" }] });

  const result = store.mergeProjects("old", "new");
  assert.equal(result.merged_entities, 1);
  assert.equal(result.entities, 2);
  assert.equal(store.listProjects().some((p) => p.key === "old"), false);

  const facts = store.getEntity({ project: "new", name: "Cache" }).observations.map((o) => o.content).sort();
  assert.deepEqual(facts, ["only new", "only old", "shared"]);
  assert.equal(store.graphAll("new").relation_count, 1);
  assert.equal(store.graphStats("new").entities, 3);
  assert.equal(store.searchEntries({ q: "old", project: "new" }).count, 1);
  assert.equal(store.recall({ project: "new", q: "unique" }).entities.length, 1);
  assert.deepEqual(store.listTaskGroups("new").map((g) => g.task_group).sort(), ["g", "g-merged"]);
  assert.throws(() => store.mergeProjects("new", "new"), /itself/);
});

test("facts that name another entity suggest a link until one exists", () => {
  const { store } = memoryStore();
  store.upsertEntity({ project: P, name: "Redis", entity_type: "tool" });
  store.upsertEntity({ project: P, name: "Sessions", entity_type: "concept" });

  const first = store.upsertEntity({
    project: P, name: "Login flow", entity_type: "pattern",
    observations: ["Keeps sessions in Redis with a 1h TTL"],
  });
  assert.deepEqual(first.link_suggestions?.sort(), ["Redis", "Sessions"]);

  store.link({ project: P, from_name: "Login flow", to_name: "Redis", relation_type: "uses" });
  const next = store.upsertEntity({ project: P, name: "Login flow", entity_type: "pattern", observations: ["Redis outage logs everyone out"] });
  assert.equal(next.link_suggestions, undefined);

  const word = store.upsertEntity({ project: P, name: "Notes", entity_type: "concept", observations: ["Redistribution is unrelated"] });
  assert.equal(word.link_suggestions, undefined);
});
