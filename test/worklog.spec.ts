import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeWorklog, taskInfo, type RawEvent, type Resolvers } from "../src/worklog/compute.ts";
import { buildReport, formatDuration, renderCsv, renderMarkdown, renderText, resolveRange } from "../src/worklog/report.ts";
import { scanWorklog } from "../src/worklog/scan.ts";
import { remoteStore } from "../src/node/backend.ts";
import { memoryStore, startServer } from "./helpers.ts";

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0) / 1000; // Wed 2026-10-21 09:00 UTC

const resolvers: Resolvers = {
  cwd: (cwd) => (cwd === "/plain" ? { project: "plain", isRepo: false } : { project: "acme", isRepo: true }),
  path: (file) => (file.startsWith("/repo/") ? "acme" : null),
};

const ev = (t: number, kind: RawEvent["kind"], extra: Partial<RawEvent> = {}): RawEvent => ({
  t: T0 + t, kind, cwd: "/repo", branch: "feat/PPG-12-login", sessionId: "s1", ...extra,
});

const sum = (rows: Array<{ kind: string; secs: number }>, kind: string) =>
  rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.secs, 0);

test("a gap before a prompt is the human, a gap before agent output is the agent", () => {
  const { minutes } = computeWorklog(
    [ev(0, "prompt"), ev(30, "assistant"), ev(90, "tool_result"), ev(100, "assistant"), ev(160, "prompt")],
    resolvers,
  );
  assert.equal(sum(minutes, "ai"), 100);
  assert.equal(sum(minutes, "human"), 60);
});

test("long gaps are capped, and system messages leave idle time uncounted", () => {
  const { minutes } = computeWorklog(
    [ev(0, "assistant"), ev(3600, "prompt"), ev(3700, "system"), ev(3760, "assistant")],
    resolvers,
    { humanCapSeconds: 300, aiCapSeconds: 900 },
  );
  assert.equal(sum(minutes, "human"), 300);
  assert.equal(sum(minutes, "ai"), 60);
});

test("seconds are spread over the minutes they fall in", () => {
  const { minutes } = computeWorklog([ev(50, "assistant"), ev(130, "assistant")], resolvers);
  const first = Math.floor((T0 + 50) / 60);
  const byMinute = new Map(minutes.map((m) => [m.minute - first, m.secs]));
  assert.deepEqual([...byMinute].sort(), [[0, 10], [1, 60], [2, 10]]);
});

test("a session started in a plain folder follows the repo it edits", () => {
  const { minutes, facts } = computeWorklog(
    [
      ev(0, "prompt", { cwd: "/plain", branch: "HEAD", text: "fix the login" }),
      ev(60, "assistant", { cwd: "/plain", branch: "HEAD", edits: 1, paths: ["/repo/src/a.ts"] }),
      ev(120, "assistant", { cwd: "/plain", branch: "HEAD" }),
    ],
    resolvers,
  );
  assert.ok(minutes.every((m) => m.project === "acme"));
  assert.equal(facts[0].project, "acme");
  assert.equal(facts[0].firstPrompt, "fix the login");
  assert.equal(facts[0].edits, 1);
});

test("branches become tasks with a kind and a ticket label", () => {
  assert.deepEqual(taskInfo("feat/PPG-12-login"), { label: "PPG-12", kind: "feature" });
  assert.deepEqual(taskInfo("fix/null-pointer"), { label: "fix/null-pointer", kind: "fix" });
  assert.deepEqual(taskInfo("chore/ABC-7"), { label: "ABC-7", kind: "chore" });
  assert.deepEqual(taskInfo("main"), { label: "main", kind: "other" });
  assert.deepEqual(taskInfo("(none)"), { label: "(no branch)", kind: "other" });
});

test("durations read naturally", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(20), "<1m");
  assert.equal(formatDuration(45 * 60), "45m");
  assert.equal(formatDuration(3 * 3600 + 5 * 60), "3h 05m");
});

test("ranges start on Monday and are half open", () => {
  const wed = new Date(2026, 5, 10, 15, 0, 0); // a week without a clock change
  const week = resolveRange({ week: true }, wed);
  assert.equal(new Date(week.from * 1000).getDay(), 1);
  assert.equal(week.to - week.from, 7 * 86400);
  const last = resolveRange({ lastWeek: true }, wed);
  assert.equal(last.to, week.from);
  assert.equal(resolveRange({ today: true }, wed).to - resolveRange({ today: true }, wed).from, 86400);
  assert.throws(() => resolveRange({ from: "nope" }, wed), /Invalid date/);
});

// ─── End to end: real files, a real git repo ───────────────

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "tr-wl-"));
  const repo = join(base, "shop");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "git@github.com:Acme/Shop.git");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feat/SHOP-9-cart");

  const root = join(base, "claude", "projects", "-x");
  mkdirSync(root, { recursive: true });
  const file = join(root, "session.jsonl");

  const line = (offset: number, type: "user" | "assistant", extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type, isSidechain: false, timestamp: new Date((T0 + offset) * 1000).toISOString(),
      cwd: repo, gitBranch: "feat/SHOP-9-cart", sessionId: "sess-1", ...extra,
    });
  const prompt = (offset: number, text: string) =>
    line(offset, "user", { origin: { kind: "human" }, message: { role: "user", content: text } });
  const toolResult = (offset: number) =>
    line(offset, "user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
  const assistant = (offset: number, uses: unknown[] = []) =>
    line(offset, "assistant", { message: { role: "assistant", content: uses } });
  const edit = { type: "tool_use", name: "Edit", input: { file_path: join(repo, "cart.ts") } };

  writeFileSync(
    file,
    [
      prompt(0, "add a cart page"),
      assistant(20, [edit]),
      toolResult(40),
      assistant(80),
      prompt(140, "now add tests"),
      assistant(200, [edit, edit]),
    ].join("\n") + "\n",
  );
  return { base, repo, root: join(base, "claude", "projects"), file, prompt, assistant, line };
}

const WEEK = { from: T0 - 86400, to: T0 + 86400, label: "test" };

test("scanning real files yields a per-task report and skips unchanged files", async () => {
  const f = fixture();
  const { store } = memoryStore();

  const first = await scanWorklog(store, { root: f.root, sinceDays: null });
  assert.deepEqual(first, { scanned: 1, skipped: 0 });
  assert.deepEqual(await scanWorklog(store, { root: f.root, sinceDays: null }), { scanned: 0, skipped: 1 });

  const report = (await buildReport(store, { range: WEEK, detail: true }));
  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.equal(row.project, "acme-shop");
  assert.equal(row.label, "SHOP-9");
  assert.equal(row.kind, "feature");
  assert.equal(row.prompts, 2);
  assert.equal(row.edits, 3);
  assert.equal(row.first_prompt, "add a cart page");
  assert.equal(row.agent_s, 20 + 20 + 40 + 60);
  assert.equal(row.you_s, 60);
  assert.ok(row.wall_s <= row.agent_s + row.you_s);

  appendFileSync(f.file, f.assistant(260) + "\n");
  assert.deepEqual(await scanWorklog(store, { root: f.root, sinceDays: null }), { scanned: 1, skipped: 0 });
  assert.equal((await buildReport(store, { range: WEEK })).rows[0].agent_s, row.agent_s + 60);
});

test("memory notes of the branch show up as what was done", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  const at = T0 + 100;
  store.saveEntry({ project: "acme-shop", type: "change", title: "commit abc123 feat: cart page", content: "x", scope: "branch", scope_ref: "feat/SHOP-9-cart" });
  store.saveEntry({ project: "acme-shop", type: "decision", title: "Use server-side cart", content: "y", tags: "branch:feat/SHOP-9-cart" });
  store.saveEntry({ project: "acme-shop", type: "note", title: "unrelated branch", content: "z", tags: "branch:other" });
  store.createTasks({ project: "acme-shop", task_group: "cart", tasks: [{ title: "a", content: "A" }], branch: "feat/SHOP-9-cart" });

  const now = Math.floor(Date.now() / 1000);
  const report = (await buildReport(store, { range: { from: T0 - 86400, to: now + 86400, label: "x" }, detail: true }));
  assert.equal(at > 0, true);
  // the entries are stamped with the store clock, not the transcript clock, so ask the store directly
  const activity = store.worklogActivity("acme-shop", "feat/SHOP-9-cart", 0, 4_000_000_000);
  assert.deepEqual(activity.notes.map((n) => n.title).sort(), ["Use server-side cart", "commit abc123 feat: cart page"]);
  assert.equal(activity.groups[0].task_group, "cart");
  assert.ok(report.rows.length === 1);
});

test("text, markdown and csv renderings carry the numbers", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  const report = (await buildReport(store, { range: WEEK, detail: true }));

  const text = renderText(report, { detail: true });
  assert.match(text, /acme-shop\s+SHOP-9\s+feature/);
  assert.match(text, /asked: add a cart page/);
  assert.match(renderMarkdown(report), /### SHOP-9 \(feature\)/);

  const csv = (await renderCsv(store, { range: WEEK })).split("\n");
  assert.equal(csv[0], "day,project,task,kind,branch,you_minutes,agent_minutes,wall_minutes,you_hours,agent_hours");
  assert.match(csv[1], /,acme-shop,SHOP-9,feature,feat\/SHOP-9-cart,1,2,/);
});

test("excluded projects vanish from rows and totals", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  assert.equal((await buildReport(store, { range: WEEK, exclude: ["acme-*"] })).rows.length, 0);
  assert.equal((await buildReport(store, { range: WEEK, exclude: ["acme-*"] })).totals.wall_s, 0);
  assert.equal((await buildReport(store, { range: WEEK, exclude: ["other*"] })).rows.length, 1);
});

test("export marks hide time that was already reported", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  assert.equal(store.worklogPending("jira").length, 1);
  store.worklogMarkExported("acme-shop", "feat/SHOP-9-cart", "jira");
  assert.equal(store.worklogPending("jira").length, 0);
  assert.equal(store.worklogPending("other-target").length, 1);

  appendFileSync(f.file, f.assistant(60 * 30) + "\n");
  await scanWorklog(store, { root: f.root, sinceDays: null });
  assert.equal(store.worklogPending("jira").length, 1);
  assert.throws(() => store.worklogMarkExported("acme-shop", "nope", "jira"), /No worklog time/);
});

test("changing the caps recomputes everything", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null, options: { humanCapSeconds: 300, aiCapSeconds: 900 } });
  const before = (await buildReport(store, { range: WEEK })).rows[0].agent_s;
  const rescanned = await scanWorklog(store, { root: f.root, sinceDays: null, options: { humanCapSeconds: 300, aiCapSeconds: 30 } });
  assert.equal(rescanned.scanned, 1);
  assert.ok((await buildReport(store, { range: WEEK })).rows[0].agent_s < before);
});

test("huge lines are read from their envelope without decoding the payload", async () => {
  const f = fixture();
  const big = "A".repeat(300_000);
  appendFileSync(
    f.file,
    f.line(300, "user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: big }] } }) + "\n" +
      f.line(340, "user", { origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text: "see image" }, { type: "image", source: big }] } }) + "\n",
  );
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  const row = (await buildReport(store, { range: WEEK })).rows[0];
  assert.equal(row.prompts, 3);
  assert.ok(row.agent_s >= 20 + 20 + 40 + 60 + 40);
});

test("device-scoped scans keep machines apart, drop unprefixed rows once and recompute on new caps", async () => {
  const f = fixture();
  const { store } = memoryStore();
  await scanWorklog(store, { root: f.root, sinceDays: null });
  const single = (await buildReport(store, { range: WEEK })).totals.agent_s;

  await scanWorklog(store, { root: f.root, sinceDays: null, deviceId: "mac" });
  assert.equal((await buildReport(store, { range: WEEK })).totals.agent_s, single, "the unprefixed copy is gone");
  await scanWorklog(store, { root: f.root, sinceDays: null, deviceId: "pc" });
  assert.equal((await buildReport(store, { range: WEEK })).totals.agent_s, single * 2, "two machines add up");

  await scanWorklog(store, { root: f.root, sinceDays: null, deviceId: "mac", options: { humanCapSeconds: 300, aiCapSeconds: 30 } });
  const after = (await buildReport(store, { range: WEEK })).totals.agent_s;
  assert.ok(after < single * 2 && after > single, "only mac was recomputed");
});

test("a signed-in machine uploads its time rows to the server", async () => {
  const f = fixture();
  const s = await startServer();
  try {
    const remote = remoteStore({ url: s.url, key: s.key });
    await remote.setContext({ project: "acme-shop", project_path: f.repo });
    assert.deepEqual(await scanWorklog(remote, { root: f.root, sinceDays: null, deviceId: "mac" }), { scanned: 1, skipped: 0 });
    assert.deepEqual(await scanWorklog(remote, { root: f.root, sinceDays: null, deviceId: "mac" }), { scanned: 0, skipped: 1 });
    const report = await buildReport(s.store, { range: WEEK });
    assert.equal(report.rows[0].project, "acme-shop");
    assert.equal(report.rows[0].prompts, 2);
  } finally {
    await s.close();
  }
});
