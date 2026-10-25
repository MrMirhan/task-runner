import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = new URL("../src/cli/index.ts", import.meta.url).pathname;

function env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(process.env as Record<string, string>), TASK_RUNNER_HOME: home, ...extra };
}

async function withServer<T>(home: string, cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", entry, "serve"],
    cwd,
    env: env(home),
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const text = (res: unknown) => JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);

test("memory written over stdio survives a restart and feeds the session hook", async () => {
  const home = mkdtempSync(join(tmpdir(), "tr-home-"));
  const project = join(mkdtempSync(join(tmpdir(), "tr-proj-")), "my-app");
  mkdirSync(project);

  await withServer(home, project, async (client) => {
    const saved = text(
      await client.callTool({
        name: "remember",
        arguments: { name: "Run migrations first", entity_type: "convention", observations: ["before every deploy"] },
      }),
    );
    assert.equal(saved.is_new, true);
  });

  await withServer(home, project, async (client) => {
    const found = text(await client.callTool({ name: "recall", arguments: { query: "deploy" } }));
    assert.equal(found.entities[0].name, "Run migrations first");
    const projects = text(await client.callTool({ name: "list_projects", arguments: {} }));
    assert.equal(projects.current, "my-app");
  });

  const hook = JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", entry, "hook", "session-start"], {
      input: JSON.stringify({ cwd: project, source: "startup" }),
      env: env(home),
      encoding: "utf8",
    }),
  );
  assert.equal(hook.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(hook.hookSpecificOutput.additionalContext, /convention Run migrations first/);
  assert.match(hook.systemMessage, /my-app/);

  const snap = JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", entry, "snapshot", "--cwd", project, "--query", "migrations"], {
      env: env(home),
      encoding: "utf8",
    }),
  );
  assert.equal(snap.project, "my-app");
  assert.equal(snap.stats.entities, 1);
  assert.equal(snap.search.entities[0].name, "Run migrations first");
});

test("a broken database never blocks the session hook", () => {
  const home = mkdtempSync(join(tmpdir(), "tr-home-"));
  const out = JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", entry, "hook", "session-start"], {
      input: "{}",
      env: env(home, { TASK_RUNNER_DB: join(home, "missing-dir", "x", "..", "..", "memory.db", "nope") }),
      encoding: "utf8",
    }),
  );
  assert.ok(out.systemMessage);
});

test("export and import move memory between databases, with a markdown vault", () => {
  const a = mkdtempSync(join(tmpdir(), "tr-a-"));
  const b = mkdtempSync(join(tmpdir(), "tr-b-"));
  const dump = join(a, "dump.json");
  const vault = join(a, "vault");
  const run = (home: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--no-warnings", entry, ...args], { env: env(home), encoding: "utf8", input: "{}" });

  run(a, "hook", "session-start");
  execFileSync(process.execPath, ["--no-warnings", "-e", `
    const { openDb } = await import(${JSON.stringify(new URL("../src/node/sqlite.ts", import.meta.url).href)});
    const { Store } = await import(${JSON.stringify(new URL("../src/core/store.ts", import.meta.url).href)});
    const db = openDb(process.env.TASK_RUNNER_HOME + "/memory.db");
    const s = new Store(db);
    s.upsertEntity({ project: "p", name: "Alpha", entity_type: "tool", observations: ["first"] });
    s.upsertEntity({ project: "p", name: "Beta", entity_type: "tool" });
    s.link({ project: "p", from_name: "Alpha", to_name: "Beta", relation_type: "uses" });
    db.close();
  `, "--input-type=module"], { env: env(a) });

  run(a, "export", "--out", dump);
  run(b, "import", dump);
  assert.match(run(b, "projects", "list"), /^p\t2 entities/m);

  run(a, "export", "--format", "markdown", "--out", vault);
  const alpha = execFileSync("cat", [join(vault, "p", "entities", "alpha.md")], { encoding: "utf8" });
  assert.match(alpha, /uses \[\[beta\|Beta\]\]/);
  assert.match(alpha, /- first/);
});
