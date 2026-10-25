import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

const localIso = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

test("the worklog tool reads transcripts through the real server", async () => {
  const home = mkdtempSync(join(tmpdir(), "tr-home-"));
  const base = mkdtempSync(join(tmpdir(), "tr-wl-e2e-"));
  const repo = join(base, "blog");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/acme/blog.git");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "fix/BLOG-3-typo");

  const config = join(base, "claude");
  mkdirSync(join(config, "projects", "-blog"), { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  const at = (back: number) => new Date((now - back) * 1000).toISOString();
  const line = (back: number, type: string, extra: Record<string, unknown>) =>
    JSON.stringify({ type, isSidechain: false, timestamp: at(back), cwd: repo, gitBranch: "fix/BLOG-3-typo", sessionId: "s", ...extra });
  writeFileSync(
    join(config, "projects", "-blog", "s.jsonl"),
    [
      line(300, "user", { origin: { kind: "human" }, message: { role: "user", content: "fix the typo on the about page" } }),
      line(270, "assistant", { message: { role: "assistant", content: [] } }),
      line(200, "assistant", { message: { role: "assistant", content: [] } }),
    ].join("\n") + "\n",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", entry, "serve"],
    cwd: repo,
    env: env(home, { CLAUDE_CONFIG_DIR: config }),
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  try {
    assert.ok((await client.listTools()).tools.some((t) => t.name === "worklog"));
    const report = text(await client.callTool({ name: "worklog", arguments: { range: "custom", from: localIso(-1), to: localIso(1), detail: true } }));
    const task = report.tasks.find((t: any) => t.task === "BLOG-3");
    assert.ok(task, JSON.stringify(report));
    assert.equal(task.project, "acme-blog");
    assert.equal(task.kind, "fix");
    assert.equal(task.agent, "2m");
    assert.equal(task.started_from, "fix the typo on the about page");
  } finally {
    await client.close();
  }
});

test("local rules reach the session hook with org and project sections", () => {
  const home = mkdtempSync(join(tmpdir(), "tr-home-"));
  const repo = join(mkdtempSync(join(tmpdir(), "tr-rules-repo-")), "shop");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:Acme/Shop.git"], { cwd: repo });
  const run = (args: string[], input = "") =>
    execFileSync(process.execPath, ["--no-warnings", entry, ...args], { cwd: repo, env: env(home), encoding: "utf8", input });

  run(["rules", "set", "Be", "brief."]);
  run(["rules", "set", "--org", "Use", "Conventional", "Commits."]);
  run(["rules", "set", "--project", "Skip", "billing."]);
  writeFileSync(join(repo, ".task-runner.json"), JSON.stringify({ org: "acme-corp" }));
  run(["rules", "set", "--org", "Pinned", "org", "rule."]);

  const hook = JSON.parse(run(["hook", "session-start"], JSON.stringify({ cwd: repo })));
  const context: string = hook.hookSpecificOutput.additionalContext;
  assert.match(context, /## Everywhere\nBe brief\./);
  assert.match(context, /## Organization acme-corp\nPinned org rule\./);
  assert.match(context, /## Project acme-shop\nSkip billing\./);
  assert.doesNotMatch(context, /Use Conventional Commits/);
  assert.ok(context.indexOf("RULES from the user") < context.indexOf("task-runner memory for"));
});
