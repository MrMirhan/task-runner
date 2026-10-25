import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";
import { SessionHolder } from "../src/mcp/session.ts";
import { memoryStore } from "./helpers.ts";

async function connect(options: { detect?: boolean; files?: Set<string> } = {}) {
  const { store } = memoryStore();
  const session = new SessionHolder(
    options.detect === false ? null : () => ({ project: "demo", project_path: "/work/demo", branch: "main", pr: null }),
  );
  const server = createServer({
    store,
    session,
    fileExists: (_root, rel) => (options.files ?? new Set()).has(rel),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content[0].text;
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError === true, data };
  };
  return { client, call, store };
}

test("every tool is documented and annotated, and the list stays small", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 16);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description`);
    assert.ok(tool.annotations, `${tool.name} needs annotations`);
  }
  assert.ok(client.getInstructions()?.includes("recall"));
});

test("works with no set_context call: the project is detected", async () => {
  const { call } = await connect();
  const saved = await call("remember", {
    name: "Retry on 429", entity_type: "pitfall", observations: ["Back off with jitter"],
  });
  assert.equal(saved.data.is_new, true);

  const found = await call("recall", { query: "jitter" });
  assert.equal(found.data.entities[0].name, "Retry on 429");
  assert.equal(found.data.entities[0].facts[0].text, "Back off with jitter");
  assert.match(found.data.entities[0].facts[0].at, /^\d{4}-\d{2}-\d{2}$/);
});

test("a long natural-language query still finds the entity", async () => {
  const { call } = await connect();
  await call("remember", { name: "Deploy order", entity_type: "convention", observations: ["Run migrations before restarting the worker"] });
  const found = await call("recall", { query: "how should we handle the migrations when we deploy the worker to production again" });
  assert.equal(found.data.entities[0].name, "Deploy order");
});

test("remember defaults the type and refuses sentence-length names", async () => {
  const { call } = await connect();
  const saved = await call("remember", { name: "Loose idea", observations: ["x"] });
  assert.equal(saved.data.entity_type, "concept");

  const long = await call("remember", { name: "x".repeat(81) });
  assert.equal(long.isError, true);
  assert.match(long.data.error, /short name/);
});

test("remembering an existing name adds facts instead of duplicating", async () => {
  const { call } = await connect();
  await call("remember", { name: "Cache", entity_type: "pattern", observations: ["one"] });
  const again = await call("remember", { name: "cache", entity_type: "pattern", observations: ["one", "two"] });
  assert.equal(again.data.is_new, false);
  assert.equal(again.data.observations_added, 1);
});

test("without detection and without set_context the error says what to do", async () => {
  const { call } = await connect({ detect: false });
  const res = await call("recall", { query: "x" });
  assert.equal(res.isError, true);
  assert.match(res.data.error, /set_context/);

  const set = await call("set_context", { project: "manual", branch: "dev" });
  assert.equal(set.data.project, "manual");
  assert.equal((await call("graph_stats")).data.project, "manual");
});

test("set_context without a project keeps the detected one and adds the PR", async () => {
  const { call } = await connect();
  const set = await call("set_context", { pr: "42" });
  assert.equal(set.data.project, "demo");
  assert.equal(set.data.pr, "42");
});

test("notes default to project scope, tag the branch and accept loose types", async () => {
  const { call } = await connect();
  const saved = await call("save_memory", { content: "Switched the build to esbuild", type: "feedback" });
  assert.equal(saved.data.scope, "project");

  const ctx = await call("get_context");
  const note = ctx.data.entries[0];
  assert.equal(note.type, "note");
  assert.equal(note.title, "Switched the build to esbuild");
  assert.match(note.tags, /feedback/);
  assert.match(note.tags, /branch:main/);
});

test("get_context clips long notes unless full is requested", async () => {
  const { call } = await connect();
  await call("save_memory", { content: "y".repeat(2000), title: "big" });
  assert.ok((await call("get_context")).data.entries[0].content.length <= 600);
  assert.equal((await call("get_context", { full: true })).data.entries[0].content.length, 2000);
});

test("fact correction flows through ids shown by recall", async () => {
  const { call } = await connect();
  await call("remember", { name: "API limit", entity_type: "concept", observations: ["100 req/min"] });
  const before = await call("what_do_i_know", { name: "API limit" });
  const factId = before.data.facts[0].id as string;

  await call("correct_fact", { fact_id: factId, new_fact: "500 req/min" });
  const after = await call("what_do_i_know", { name: "API limit" });
  assert.deepEqual(after.data.facts.map((f: { text: string }) => f.text), ["500 req/min"]);
});

test("global scope is visible from any project", async () => {
  const { call } = await connect();
  await call("remember", { name: "Reply language", entity_type: "preference", observations: ["Turkish"], scope: "global" });
  await call("set_context", { project: "elsewhere" });
  const found = await call("recall", { query: "turkish" });
  assert.equal(found.data.entities[0].project, "_global");
});

test("link uses natural argument names and explains a missing entity", async () => {
  const { call } = await connect();
  await call("remember", { name: "Cache", entity_type: "pattern" });
  await call("remember", { name: "Redis", entity_type: "tool" });

  const linked = await call("link", { from: "Cache", to: "Redis", relation: "uses", context: "fast reads" });
  assert.equal(linked.data.is_new, true);
  const defaulted = await call("link", { from: "Redis", to: "Cache" });
  assert.equal(defaulted.data.relation, "relates_to");

  const detail = await call("what_do_i_know", { name: "Cache" });
  assert.equal(detail.data.out[0].target, "Redis (tool)");
  assert.equal(detail.data.out[0].why, "fast reads");

  const missing = await call("link", { from: "Cache", to: "Ghost" });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /Create it with remember first/);

  await call("forget", { name: "Redis" });
  assert.equal((await call("what_do_i_know", { name: "Redis" })).isError, true);
});

test("store errors become tool errors, not protocol errors", async () => {
  const { call } = await connect();
  const res = await call("what_do_i_know", { name: "ghost" });
  assert.equal(res.isError, true);
  assert.match(res.data.error, /not found/);
});

test("the task loop works end to end through tools", async () => {
  const { call } = await connect();
  const created = await call("create_task_group", {
    name: "Ship It", markdown: "## Task 1: Build\nbuild it\n## Task 2: Test\ntest it",
  });
  assert.equal(created.data.task_group, "ship-it");
  assert.equal(created.data.task_count, 2);

  const first = await call("get_next_task");
  assert.equal(first.data.task.id, "task-001");
  await call("complete_task", { task_id: "task-001", result: "built" });
  await call("get_next_task");
  await call("complete_task", { task_id: "task-002", result: "red tests", status: "failed" });

  const status = await call("get_task_status");
  assert.equal(status.data.summary.completed, 1);
  assert.equal(status.data.summary.failed, 1);
  assert.equal((await call("get_task_status", { task_id: "task-001" })).data.result, "built");
  assert.equal((await call("get_task_status", { task_id: "task-002" })).data.error, "red tests");
  assert.equal((await call("get_next_task")).data.done, true);

  assert.equal((await call("clear_tasks")).data.cleared, 2);
  assert.equal((await call("get_task_status")).isError, true);
});

test("create_task_group rejects empty input and unfinished overwrites", async () => {
  const { call } = await connect();
  assert.equal((await call("create_task_group", { name: "x", markdown: "no headings here" })).isError, true);
  await call("create_task_group", { name: "x", tasks: [{ title: "a", content: "A" }] });
  await call("get_next_task");
  const again = await call("create_task_group", { name: "x", tasks: [{ title: "a", content: "A" }] });
  assert.equal(again.isError, true);
  assert.match(again.data.error, /replace/);
});

test("graph_stats check flags file entities whose path is gone", async () => {
  const { call } = await connect({ files: new Set(["src/kept.ts"]) });
  await call("remember", { name: "src/kept.ts", entity_type: "file" });
  await call("remember", { name: "src/removed.ts", entity_type: "file" });
  await call("remember", { name: "Not a path", entity_type: "file" });

  const plain = await call("graph_stats");
  assert.equal(plain.data.entities, 3);
  assert.equal(plain.data.missing_files, undefined);

  const checked = await call("graph_stats", { check: true });
  assert.deepEqual(checked.data.missing_files, ["src/removed.ts"]);
});

test("list_projects filters and stays compact", async () => {
  const { call } = await connect();
  await call("set_context", { project: "alpha", project_path: "/w/alpha" });
  await call("set_context", { project: "beta", project_path: "/w/beta" });
  const res = await call("list_projects", { query: "alp" });
  assert.equal(res.data.total, 1);
  assert.equal(res.data.projects[0].key, "alpha");
});

test("tool output is compact JSON", async () => {
  const { client } = await connect();
  const res = (await client.callTool({ name: "list_projects", arguments: {} })) as { content: Array<{ text: string }> };
  assert.ok(!res.content[0].text.includes("\n"));
});
