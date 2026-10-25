import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDashboardServer } from "../src/cli/dashboard.ts";
import { memoryStore } from "./helpers.ts";

const getJson = async (url: string): Promise<any> => (await fetch(url)).json();

/** fetch() hides the Host and Origin headers, so hostile requests go through node:http. */
function raw(base: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = request(base + path, { headers }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function start() {
  const { store } = memoryStore();
  store.upsertEntity({ project: "p", name: "Alpha", entity_type: "tool", observations: ["fact one"] });
  store.upsertEntity({ project: "p", name: "Beta", entity_type: "tool" });
  store.link({ project: "p", from_name: "Alpha", to_name: "Beta", relation_type: "uses" });
  store.saveEntry({ project: "p", type: "note", title: "hello", content: "world" });
  store.createTasks({ project: "p", task_group: "g", tasks: [{ title: "a", content: "A" }] });

  const dir = mkdtempSync(join(tmpdir(), "tr-static-"));
  writeFileSync(join(dir, "index.html"), "<h1>dash</h1>");
  mkdirSync(join(dir, "_next"));
  writeFileSync(join(dir, "_next", "app.js"), "console.log(1)");

  const server = createDashboardServer(store, dir);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, store, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("serves the API with the shapes the dashboard reads", async () => {
  const { base, close } = await start();
  try {
    const projects = await getJson(`${base}/api/projects`);
    assert.equal(projects.projects[0].key, "p");

    const graph = await getJson(`${base}/api/graph/all?project_key=p`);
    assert.equal(graph.entity_count, 2);
    assert.equal(graph.relation_count, 1);
    assert.equal(graph.entities.find((e: any) => e.name === "Alpha").observation_count, 1);

    const stats = await getJson(`${base}/api/graph/stats?project_key=p`);
    assert.equal(stats.entity_types[0].cnt, 2);

    const alpha = graph.entities.find((e: any) => e.name === "Alpha");
    const detail = await getJson(`${base}/api/entities?id=${alpha.id}`);
    assert.equal(detail.observations[0].content, "fact one");
    assert.equal(detail.relations.outgoing[0].target_name, "Beta");

    const groups = await getJson(`${base}/api/tasks/groups?project_key=p`);
    assert.equal(groups.groups[0].task_group, "g");
    const tasks = await getJson(`${base}/api/tasks/status?project_key=p&task_group=g`);
    assert.equal(tasks.tasks[0].id, "task-001");

    const context = await getJson(`${base}/api/context?project=p&all=true`);
    assert.equal(context.entries[0].title, "hello");
  } finally {
    await close();
  }
});

test("creates, edits and deletes notes through the API", async () => {
  const { base, store, close } = await start();
  const json = { "Content-Type": "application/json" };
  try {
    const created: any = await (
      await fetch(`${base}/api/memory`, {
        method: "POST", headers: json,
        body: JSON.stringify({ project_key: "p", type: "decision", title: "Use X", content: "because" }),
      })
    ).json();
    assert.equal(created.success, true);

    await fetch(`${base}/api/memory`, { method: "PUT", headers: json, body: JSON.stringify({ id: created.id, content: "changed" }) });
    assert.equal(store.searchEntries({ q: "changed", project: "p" }).count, 1);

    await fetch(`${base}/api/memory?id=${created.id}`, { method: "DELETE" });
    assert.equal(store.searchEntries({ q: "changed", project: "p" }).count, 0);

    const missing = await fetch(`${base}/api/memory?id=nope`, { method: "DELETE" });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test("refuses foreign hosts, foreign origins and non-JSON writes", async () => {
  const { base, close } = await start();
  try {
    const port = new URL(base).port;
    assert.equal(await raw(base, "/api/projects", { Host: `evil.example:${port}` }), 403);
    assert.equal(await raw(base, "/api/projects", { Origin: "https://evil.example" }), 403);
    assert.equal(await raw(base, "/api/projects", { Origin: base }), 200);

    const form = await fetch(`${base}/api/memory`, {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ project_key: "p", type: "note", title: "t", content: "c" }),
    });
    assert.equal(form.status, 415);
  } finally {
    await close();
  }
});

test("serves static files and keeps requests inside the folder", async () => {
  const { base, close } = await start();
  try {
    assert.match(await (await fetch(`${base}/`)).text(), /<h1>dash<\/h1>/);
    assert.match(await (await fetch(`${base}/_next/app.js`)).text(), /console/);
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.match(await (await fetch(`${base}/some/route`)).text(), /<h1>dash<\/h1>/);
    const escape = await (await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).text();
    assert.ok(!escape.includes("root:"), "must not read outside the static folder");
  } finally {
    await close();
  }
});
