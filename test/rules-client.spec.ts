import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/core/store.ts";
import { handleApp } from "../src/http/app.ts";
import { RulesStore } from "../src/core/rules.ts";
import { RemoteRulesClient, readRulesCache, resolveForHook } from "../src/node/remote.ts";
import { openDb } from "../src/node/sqlite.ts";

const entry = new URL("../src/cli/index.ts", import.meta.url).pathname;

/** The Worker's handler on a Node HTTP server: same routes, same auth, an in-memory database. */
async function startServer(key = "test-key-0123456789abcdefghij") {
  const db = openDb(":memory:");
  const rules = new RulesStore(db);
  const store = new Store(db);
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const method = req.method ?? "GET";
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const out = await handleApp({ store, rules, key }, request);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, rules, store, close: () => new Promise<void>((r) => server.close(() => r())), key };
}

const ctx = { project: "acme-shop", org: "acme", device: "dev-1" };

test("the remote client reads, writes, proposes and approves", async () => {
  const s = await startServer();
  try {
    const client = new RemoteRulesClient({ url: s.url, key: s.key });
    await client.registerDevice({ id: "dev-1", label: "macbook", platform: "darwin" });
    await client.setDoc({ scope: "global" }, "Be brief.");
    await client.setDoc({ scope: "project", ref: "acme-shop" }, "No schema changes.");
    await client.setDoc({ scope: "device", device: "dev-1" }, "Use brew.");

    const resolved = await client.resolve(ctx);
    assert.match(resolved.text, /Be brief\./);
    assert.match(resolved.text, /This device \(macbook\)/);
    assert.match(resolved.text, /No schema changes\./);

    const proposal = await client.propose({ key: { scope: "org", ref: "acme" }, text: "Use Conventional Commits.", reason: "asked twice", author: "agent" });
    assert.equal((await client.resolve(ctx)).pending, 1);
    assert.doesNotMatch((await client.resolve(ctx)).text, /Conventional/);
    await client.approve(proposal.id);
    assert.match((await client.resolve(ctx)).text, /Conventional Commits/);
    assert.equal((await client.listDocs()).length, 4);
    assert.equal((await client.listDevices())[0].label, "macbook");
  } finally {
    await s.close();
  }
});

test("a wrong key is refused with the server's message", async () => {
  const s = await startServer();
  try {
    await assert.rejects(new RemoteRulesClient({ url: s.url, key: "nope" }).resolve(ctx), /Unauthorized/);
  } finally {
    await s.close();
  }
});

test("when the server is down the last good rules are used and marked stale", async () => {
  const home = mkdtempSync(join(tmpdir(), "tr-cache-"));
  const env = { ...process.env, TASK_RUNNER_HOME: home };
  const s = await startServer();
  const client = new RemoteRulesClient({ url: s.url, key: s.key }, 500);
  await client.setDoc({ scope: "global" }, "Always run the tests.");

  const fresh = await resolveForHook(client, ctx, env);
  assert.equal(fresh.stale, false);
  assert.match(fresh.text, /Always run the tests/);
  assert.match(readRulesCache(ctx, env)?.text ?? "", /Always run the tests/);

  await s.close();
  const offline = await resolveForHook(client, ctx, env);
  assert.equal(offline.stale, true);
  assert.match(offline.text, /Always run the tests/);
  assert.ok(offline.error);

  const other = await resolveForHook(client, { ...ctx, project: "never-seen" }, env);
  assert.equal(other.text, "");
  assert.ok(other.error);
});

test("login, rules set and the session hook work together through the CLI", async () => {
  const s = await startServer();
  const home = mkdtempSync(join(tmpdir(), "tr-login-"));
  const repo = join(mkdtempSync(join(tmpdir(), "tr-repo-")), "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:Acme/Shop.git"], { cwd: repo });

  const env = { ...process.env, TASK_RUNNER_HOME: home } as Record<string, string>;
  // Async on purpose: the stand-in server lives in this process and must keep answering.
  const run = async (args: string[], input = ""): Promise<string> => {
    const child = promisify(execFile)(process.execPath, ["--no-warnings", entry, ...args], { cwd: repo, env, encoding: "utf8" });
    child.child.stdin?.end(input);
    return (await child).stdout;
  };

  try {
    await assert.rejects(run(["login", "http://example.com", "--key", "k"]), /Command failed/);
    await assert.rejects(run(["login", s.url, "--key", "wrong"]), /Command failed/);

    assert.match(await run(["login", s.url, "--key", s.key, "--label", "test-box"]), /device "test-box"/);
    await run(["rules", "set", "Reply", "briefly", "everywhere"]);
    await run(["rules", "set", "--org", "Commits", "follow", "Conventional", "Commits"]);
    await run(["rules", "set", "--project", "--device", "Run", "the", "stack", "with", "docker"]);

    const hook = JSON.parse(await run(["hook", "session-start"], JSON.stringify({ cwd: repo })));
    const context: string = hook.hookSpecificOutput.additionalContext;
    assert.match(context, /## Everywhere\nReply briefly everywhere/);
    assert.match(context, /## Organization acme\nCommits follow Conventional Commits/);
    assert.match(context, /## Project acme-shop on this device\nRun the stack with docker/);
    assert.match(hook.systemMessage, /rules/);

    s.rules.propose({ key: { scope: "global" }, text: "Prefer small PRs.", author: "agent" });
    assert.match(await run(["rules", "pending"]), /Prefer small PRs\./);
    const id = /prop_[0-9a-f]+/.exec(await run(["rules", "pending"]))![0];
    await run(["rules", "approve", id]);
    assert.match(await run(["rules", "show"]), /Prefer small PRs\./);
    assert.match(await run(["rules", "devices"]), /test-box\t.*\(this device\)/);

    // Signed in, memory goes to the server as well.
    await run(["note", "The", "checkout", "uses", "Stripe"]);
    assert.match(JSON.stringify(s.store.getContext({ project: "acme-shop", all: true })), /checkout uses Stripe/);

    assert.match(await run(["logout"]), /Signed out/);
    assert.match(await run(["rules", "show"]), /no rules yet/);
  } finally {
    await s.close();
  }
});

test("the MCP endpoint serves the same tools over HTTP and keeps memory on the server", async () => {
  const s = await startServer();
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${s.key}`, ...headers } } }));
    return client;
  };
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const out = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { error: out.isError, data: JSON.parse(out.content[0].text) };
  };
  try {
    const a = await connect({ "X-Task-Runner-Project": "acme-shop", "X-Task-Runner-Org": "acme" });
    const tools = (await a.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("recall") && tools.includes("rules") && tools.includes("worklog"));
    assert.equal((await call(a, "remember", { name: "checkout", observations: ["Payments go through Stripe"] })).error, undefined);
    await a.close();

    // Another device without headers: no scope until set_context, which the server keeps.
    const b = await connect({});
    assert.equal((await call(b, "recall", { query: "stripe" })).error, true);
    await call(b, "set_context", { project: "acme-shop" });
    await b.close();
    const c = await connect({});
    const found = await call(c, "recall", { query: "stripe payments" });
    assert.match(JSON.stringify(found.data), /Payments go through Stripe/);
    assert.equal(s.store.graphStats("acme-shop").entities, 1);
    await c.close();

    const unauthorized = await fetch(`${s.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.status, 401);
  } finally {
    await s.close();
  }
});
