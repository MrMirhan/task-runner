import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MAX_DOC_CHARS, MAX_RESOLVED_CHARS, RulesStore } from "../src/core/rules.ts";
import { openDb } from "../src/node/sqlite.ts";

function rules() {
  let now = 1_700_000_000;
  const store = new RulesStore(openDb(":memory:"), () => ++now);
  return store;
}

const ctx = { project: "acme-shop", org: "acme", device: "dev-mac" };

test("sections come least specific first and carry readable labels", () => {
  const r = rules();
  r.registerDevice({ id: "dev-mac", label: "macbook", platform: "darwin" });
  r.setDoc({ scope: "global" }, "Reply in the user's language.");
  r.setDoc({ scope: "device", device: "dev-mac" }, "Use brew, not apt.");
  r.setDoc({ scope: "org", ref: "acme" }, "Commits follow Conventional Commits.");
  r.setDoc({ scope: "project", ref: "acme-shop" }, "Never touch the billing module.");
  r.setDoc({ scope: "project_device", ref: "acme-shop", device: "dev-mac" }, "Run the stack with docker compose.");

  const out = r.resolve(ctx);
  const order = ["## Everywhere", "## This device (macbook)", "## Organization acme", "## Project acme-shop\n", "## Project acme-shop on this device"].map((h) => out.text.indexOf(h));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), out.text);
  assert.deepEqual(out.parts.map((p) => p.scope), ["global", "device", "org", "project", "project_device"]);
  assert.equal(out.truncated, false);
});

test("other projects, orgs and devices are not included", () => {
  const r = rules();
  r.setDoc({ scope: "project", ref: "other" }, "other project rule");
  r.setDoc({ scope: "org", ref: "other-org" }, "other org rule");
  r.setDoc({ scope: "device", device: "dev-linux" }, "other device rule");
  r.setDoc({ scope: "global" }, "global rule");
  const out = r.resolve(ctx);
  assert.match(out.text, /global rule/);
  assert.doesNotMatch(out.text, /other/);
});

test("nothing configured resolves to an empty string", () => {
  assert.equal(rules().resolve(ctx).text, "");
});

test("scopes demand what they need", () => {
  const r = rules();
  assert.throws(() => r.setDoc({ scope: "org" }, "x"), /organization/);
  assert.throws(() => r.setDoc({ scope: "project" }, "x"), /project/);
  assert.throws(() => r.setDoc({ scope: "device" }, "x"), /device/);
  assert.throws(() => r.setDoc({ scope: "project_device", ref: "p" }, "x"), /device/);
  assert.throws(() => r.setDoc({ scope: "everything" as never }, "x"), /scope must be one of/);
});

test("documents keep a history and an empty body removes them", () => {
  const r = rules();
  const first = r.setDoc({ scope: "global" }, "one");
  r.setDoc({ scope: "global" }, "two");
  r.setDoc({ scope: "global" }, "two");
  assert.equal(r.getDoc({ scope: "global" })?.version, 2);
  assert.deepEqual(r.revisions(first.id!).map((x) => (x as { body: string }).body), ["two", "one"]);

  assert.equal(r.setDoc({ scope: "global" }, "  ").removed, true);
  assert.equal(r.getDoc({ scope: "global" }), null);
  assert.equal(r.setDoc({ scope: "global" }, "").removed, false);
});

test("a document over the limit is refused", () => {
  assert.throws(() => rules().setDoc({ scope: "global" }, "x".repeat(MAX_DOC_CHARS + 1)), /limited to/);
});

test("over budget the broad sections give way and a note says so", () => {
  const r = rules();
  r.setDoc({ scope: "global" }, "G".repeat(300));
  r.setDoc({ scope: "project", ref: "acme-shop" }, "P".repeat(300));
  const out = r.resolve(ctx, { maxChars: 400 });
  assert.equal(out.truncated, true);
  assert.match(out.text, /\[cut: rules exceed 400 characters\]/);
  assert.match(out.text, /P{300}/);
});

test("an agent can only propose; approval writes the rule", () => {
  const r = rules();
  r.setDoc({ scope: "project", ref: "acme-shop" }, "Rule A");
  const p = r.propose({ key: { scope: "project", ref: "acme-shop" }, text: "Rule B", reason: "the user corrected me twice" });
  assert.equal(p.status, "pending");
  assert.equal(r.resolve(ctx).text.includes("Rule B"), false);
  assert.equal(r.pendingCount(), 1);

  r.approve(p.id);
  assert.equal(r.getDoc({ scope: "project", ref: "acme-shop" })?.body, "Rule A\nRule B");
  assert.equal(r.pendingCount(), 0);
  assert.throws(() => r.approve(p.id), /already approved/);
});

test("replace proposals overwrite, edited text is what gets written, rejects change nothing", () => {
  const r = rules();
  r.setDoc({ scope: "global" }, "old");
  const replace = r.propose({ key: { scope: "global" }, mode: "replace", text: "new" });
  r.approve(replace.id, "new, but shorter");
  assert.equal(r.getDoc({ scope: "global" })?.body, "new, but shorter");

  const no = r.propose({ key: { scope: "global" }, text: "unwanted" });
  r.reject(no.id);
  assert.equal(r.getDoc({ scope: "global" })?.body, "new, but shorter");
  assert.equal(r.listProposals("rejected").length, 1);
  assert.throws(() => r.reject(no.id), /already rejected/);
});

test("duplicate and excessive proposals are refused", () => {
  const r = rules();
  r.propose({ key: { scope: "global" }, text: "same" });
  assert.throws(() => r.propose({ key: { scope: "global" }, text: "same" }), /already waiting/);
  for (let i = 0; i < 49; i++) r.propose({ key: { scope: "global" }, text: `rule ${i}` });
  assert.throws(() => r.propose({ key: { scope: "global" }, text: "one more" }), /Too many/);
});

test("devices register once and can be renamed", () => {
  const r = rules();
  r.registerDevice({ id: "d1", label: "macbook", platform: "darwin" });
  r.registerDevice({ id: "d1", label: "ignored on second call" });
  assert.equal(r.listDevices().length, 1);
  assert.equal((r.listDevices()[0] as { label: string }).label, "macbook");
  r.renameDevice("d1", "work laptop");
  assert.equal((r.listDevices()[0] as { label: string }).label, "work laptop");
  assert.throws(() => r.renameDevice("nope", "x"), /not found/);
});

test("the dashboard checks rule length against the same limits as the server", () => {
  const types = readFileSync(new URL("../dashboard/app/lib/types.ts", import.meta.url), "utf8");
  assert.match(types, new RegExp(`MAX_DOC_CHARS = ${MAX_DOC_CHARS};`));
  assert.match(types, new RegExp(`MAX_RESOLVED_CHARS = ${MAX_RESOLVED_CHARS};`));
});
