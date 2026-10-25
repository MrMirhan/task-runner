import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaste } from "../src/core/taste.ts";
import { memoryStore } from "./helpers.ts";

const P = "acme-shop";

test("a preference counts from the first time, firms up when said again and is found in other words", () => {
  const { store, tick } = memoryStore();
  store.setContext({ project: P });
  const first = store.tasteLearn({ project: P, items: [{ scope: "global", area: "replies", rule: "Reply in the language the user writes in." }] });
  assert.equal(first.learned[0].action, "new");
  assert.equal(first.learned[0].confidence, 0.5);
  assert.equal(store.tasteList({ project: P }).length, 1);

  tick(60);
  const again = store.tasteLearn({ project: P, items: [{ action: "new", scope: "global", rule: "Reply in the language the user writes in, always." }] });
  assert.equal(again.learned[0].action, "reinforce");
  const [row] = store.tasteList({ project: P });
  assert.equal(row.hits, 2);
  assert.equal(row.confidence, 0.75);
});

test("a different wish on the same point replaces the old one and keeps what it replaced", () => {
  const { store } = memoryStore();
  store.setContext({ project: P });
  const { learned } = store.tasteLearn({ project: P, items: [{ scope: "project", area: "commits", rule: "Use one-line commit messages." }] });
  store.tasteLearn({ project: P, items: [{ action: "replace", id: learned[0].id, area: "commits", rule: "Add a short body to commits that change behaviour." }] });
  const rows = store.tasteList({ project: P });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].rule, "Add a short body to commits that change behaviour.");
  assert.equal(rows[0].replaced, "Use one-line commit messages.");
  assert.equal(rows[0].scope, "project");
});

test("refine adjusts the words, drop takes it back, forget retires it", () => {
  const { store } = memoryStore();
  store.setContext({ project: P });
  const a = store.tasteLearn({ project: P, items: [{ scope: "global", area: "testing", rule: "Run the tests before saying done." }] }).learned[0];
  store.tasteLearn({ project: P, items: [{ action: "refine", id: a.id, rule: "Run the tests and show the output before saying done." }] });
  const [refined] = store.tasteList({ project: P });
  assert.match(refined.rule, /show the output/);
  assert.ok(refined.confidence > 0.5 && refined.confidence < 0.75);

  store.tasteLearn({ project: P, items: [{ action: "drop", id: a.id }] });
  assert.equal(store.tasteList({ project: P }).length, 0);

  const b = store.tasteLearn({ project: P, items: [{ scope: "global", rule: "Prefer pnpm." }] }).learned[0];
  store.tasteForget(b.id);
  assert.equal(store.tasteList({ project: P }).length, 0);
  assert.throws(() => store.tasteForget(b.id), /No preference/);
});

test("scopes: global everywhere, org for its repositories, project for one codebase", () => {
  const { store } = memoryStore();
  store.setContext({ project: P });
  store.setContext({ project: "acme-api" });
  store.setContext({ project: "other-app" });
  store.tasteLearn({
    project: P,
    org: "acme",
    items: [
      { scope: "global", rule: "Be brief." },
      { scope: "org", rule: "Use Conventional Commits." },
      { scope: "project", rule: "Never touch the billing module." },
    ],
  });
  assert.equal(store.tasteList({ project: P, org: "acme" }).length, 3);
  assert.deepEqual(store.tasteList({ project: "acme-api", org: "acme" }).map((r) => r.rule).sort(), ["Be brief.", "Use Conventional Commits."]);
  assert.deepEqual(store.tasteList({ project: "other-app", org: "other" }).map((r) => r.rule), ["Be brief."]);

  // Without an org the org scope falls back to the project.
  store.tasteLearn({ project: "other-app", items: [{ scope: "org", rule: "Tabs, not spaces." }] });
  assert.equal(store.tasteList({ project: "other-app" }).find((r) => r.rule === "Tabs, not spaces.")?.scope, "project");
});

test("the injected section lists the firmest first and stays within its budget", () => {
  const { store } = memoryStore();
  store.setContext({ project: P });
  const weak = store.tasteLearn({ project: P, items: [{ scope: "global", area: "ui", rule: "One accent colour per screen." }] }).learned[0];
  const firm = store.tasteLearn({ project: P, items: [{ scope: "global", area: "replies", rule: "Answer questions; do not implement them." }] }).learned[0];
  for (let i = 0; i < 3; i++) store.tasteLearn({ project: P, items: [{ action: "reinforce", id: firm.id }] });
  const text = formatTaste(store.tasteList({ project: P }));
  assert.ok(text.indexOf("Answer questions") < text.indexOf("One accent colour"));
  assert.match(text, /\(firm\)/);
  assert.match(text, /\(said once\)/);
  assert.ok(weak.id);
  assert.ok(formatTaste(store.tasteList({ project: P }), 200).length <= 200);
});

test("preferences travel with an export", () => {
  const { store } = memoryStore();
  store.setContext({ project: P });
  store.tasteLearn({ project: P, items: [{ scope: "global", rule: "Be brief." }] });
  const data = store.exportAll(P);
  const fresh = memoryStore().store;
  fresh.importAll(data);
  assert.equal(fresh.tasteList({ project: P })[0].rule, "Be brief.");
});

test("merging projects carries their preferences and keeps the folder", () => {
  const { store } = memoryStore();
  store.setContext({ project: "Shop", project_path: "/work/shop" });
  store.setContext({ project: "acme-shop" });
  store.tasteLearn({ project: "Shop", items: [{ scope: "project", rule: "Never touch the billing module." }] });
  store.mergeProjects("Shop", "acme-shop");
  assert.equal(store.tasteList({ project: "acme-shop" })[0].rule, "Never touch the billing module.");
  assert.equal(store.findProjectByPath("/work/shop"), "acme-shop");
  assert.equal(store.listProjects().find((p) => p.key === "acme-shop")?.project_path, "/work/shop");
});
