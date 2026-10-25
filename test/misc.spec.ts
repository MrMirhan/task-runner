import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ftsQuery } from "../src/core/fts.ts";
import { parseTaskMarkdown, slugify } from "../src/core/parser.ts";
import { detectProject, keyFromRemote } from "../src/node/project.ts";
import { openDb } from "../src/node/sqlite.ts";

test("parseTaskMarkdown reads numbered task headings", () => {
  const tasks = parseTaskMarkdown("## Task 1: Setup\nInstall deps\n\n## Task 2: Build\nRun it\nTwice\n");
  assert.deepEqual(tasks, [
    { title: "Setup", content: "Install deps" },
    { title: "Build", content: "Run it\nTwice" },
  ]);
});

test("parseTaskMarkdown falls back to plain level-two headings", () => {
  const tasks = parseTaskMarkdown("# Plan\n\n## Write tests\nCover store\n### detail\nmore\n## Ship\n");
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].title, "Write tests");
  assert.match(tasks[0].content, /detail/);
  assert.equal(tasks[1].content, "Ship");
});

test("slugify handles Turkish letters and empty input", () => {
  assert.equal(slugify("Çok Güzel İş Ağacı"), "cok-guzel-is-agaci");
  assert.equal(slugify("!!!"), "tasks");
});

test("ftsQuery quotes, dedupes and prefixes tokens", () => {
  assert.equal(ftsQuery('Redis AND "cache"'), '"redis"* OR "cache"*');
  assert.equal(ftsQuery("how do we deploy the worker"), '"how"* OR "deploy"* OR "worker"*');
  assert.equal(ftsQuery("the and of"), '"the"* OR "and"* OR "of"*');
  assert.equal(ftsQuery("a a"), '"a"');
  assert.equal(ftsQuery("***"), null);
});

test("keyFromRemote normalises common remote formats", () => {
  assert.equal(keyFromRemote("git@github.com:MrMirhan/task-runner-mcp.git"), "mrmirhan-task-runner-mcp");
  assert.equal(keyFromRemote("https://github.com/acme/web.git"), "acme-web");
  assert.equal(keyFromRemote("ssh://git@git.example.com:2222/team/app"), "team-app");
  assert.equal(keyFromRemote("file"), null);
});

test("transactions roll back, including nested ones", () => {
  const db = openDb(":memory:");
  db.exec("CREATE TABLE t (n INTEGER)");

  assert.throws(() =>
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (1)");
      throw new Error("boom");
    }),
  );
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM t")?.c, 0);

  db.transaction(() => {
    db.run("INSERT INTO t VALUES (1)");
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (2)");
        throw new Error("inner");
      }),
    );
    db.run("INSERT INTO t VALUES (3)");
  });
  assert.deepEqual(db.all("SELECT n FROM t ORDER BY n").map((r) => (r as { n: number }).n), [1, 3]);
});

test("a linked worktree resolves to the same project as its main checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "tr-wt-"));
  const main = join(base, "extranet");
  const tree = join(base, "extranet-jellyfish");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: main, stdio: "pipe" });
  mkdirSync(main);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:Acme/Extranet.git");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "feat/jellyfish", tree);

  const plain = detectProject(tree, undefined, {});
  assert.equal(plain.project, "acme-extranet");
  assert.equal(plain.branch, "feat/jellyfish");
  assert.equal(detectProject(main, undefined, {}).project, "acme-extranet");
  assert.notEqual(plain.project_path, detectProject(main, undefined, {}).project_path);

  // a key already stored for the main checkout (for example an imported one) wins for its worktrees too
  const known = new Map([[detectProject(main, undefined, {}).project_path, "legacy-extranet"]]);
  assert.equal(detectProject(tree, (p) => known.get(p) ?? null, {}).project, "legacy-extranet");

  // a pinned key beats everything
  writeFileSync(join(tree, ".task-runner.json"), JSON.stringify({ project: "pinned" }));
  assert.equal(detectProject(tree, (p) => known.get(p) ?? null, {}).project, "pinned");
  assert.equal(detectProject(tree, undefined, { TASK_RUNNER_PROJECT: "from-env" }).project, "from-env");
});

test("a plain copy of a repo (same remote) keeps the key", () => {
  const base = mkdtempSync(join(tmpdir(), "tr-copy-"));
  const a = join(base, "extranet");
  const b = join(base, "extranet-copy");
  mkdirSync(a);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: a });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/extranet.git"], { cwd: a });
  cpSync(a, b, { recursive: true });
  assert.equal(detectProject(b, undefined, {}).project, detectProject(a, undefined, {}).project);
});
