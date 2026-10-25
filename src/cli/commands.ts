import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GLOBAL_PROJECT, SERVER_VERSION } from "../core/constants.ts";
import { renderVault } from "../core/markdown.ts";
import { Store, type ExportData } from "../core/store.ts";
import { detectProject } from "../node/project.ts";
import { defaultDbPath, openDb, type NodeDb } from "../node/sqlite.ts";
import { formatDigest } from "./digest.ts";

export interface Opened {
  db: NodeDb;
  store: Store;
  path: string;
}

export function openStore(): Opened {
  const path = defaultDbPath();
  const db = openDb(path);
  return { db, store: new Store(db), path };
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const has = (args: string[], name: string): boolean => args.includes(name);

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function stdinJson(): Record<string, unknown> {
  const raw = readStdin().trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolves the project for a directory using the opened store, registering it on first sight. */
export function projectFor(store: Store, cwd: string) {
  const detected = detectProject(cwd, (p) => store.findProjectByPath(p));
  store.setContext({ project: detected.project, project_path: detected.project_path });
  return detected;
}

// ─── hook session-start ──────────────────────────────────

export function hookSessionStart(): void {
  const input = stdinJson();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  let output: Record<string, unknown>;

  try {
    const { store, db } = openStore();
    const detected = projectFor(store, cwd);
    const { context, status } = formatDigest(detected, store.digest(detected.project));
    db.close();
    output = {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
      systemMessage: status,
    };
  } catch (error) {
    // A broken memory store must never block a session from starting.
    output = { systemMessage: `task-runner: memory unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// ─── snapshot (feeds the live panel) ─────────────────────

export function snapshot(args: string[]): void {
  const cwd = resolve(flag(args, "--cwd") ?? process.cwd());
  const query = flag(args, "--query");
  const entity = flag(args, "--entity");
  const { store, db } = openStore();
  const detected = projectFor(store, cwd);
  const project = detected.project;

  if (entity) {
    const out = store.describe({ project, name: entity, entity_type: flag(args, "--type") });
    db.close();
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }

  const group = store.latestGroup(project);
  const tasks = group
    ? { summary: store.taskSummary(project, group), items: (store.taskStatus({ project, task_group: group }) as { tasks: unknown[] }).tasks }
    : null;

  const graph = store.graphAll(project);
  const out = {
    project,
    branch: detected.branch,
    stats: store.graphStats(project),
    tasks,
    notes: store.getContext({ project, all: true, limit: 8 }).entries,
    entities: graph.entities.slice(0, 40),
    relations: graph.relations.length,
    search: query ? store.recall({ project, q: query, limit: 8 }) : undefined,
  };
  db.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// ─── forget / note (used by the panel and the slash commands) ──

export function forgetCommand(args: string[]): void {
  const name = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!name) fail("Usage: task-runner-mcp forget <name> [--type t] [--cwd dir]");
  const { store, db } = openStore();
  const detected = projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd()));
  const result = store.forget({ project: detected.project, name: name!, entity_type: flag(args, "--type") });
  db.close();
  console.log(JSON.stringify(result));
}

export function noteCommand(args: string[]): void {
  const text = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))).join(" ").trim();
  if (!text) fail("Usage: task-runner-mcp note <text> [--cwd dir]");
  const { store, db } = openStore();
  const detected = projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd()));
  const title = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  const type = flag(args, "--type") ?? "note";
  const saved = store.saveEntry({
    project: detected.project,
    type,
    title,
    content: text,
    scope: detected.branch ? "branch" : "project",
    scope_ref: detected.branch,
  });
  db.close();
  console.log(JSON.stringify(saved));
}

// ─── export / import ─────────────────────────────────────

export function exportCommand(args: string[]): void {
  const { store, db } = openStore();
  const project = flag(args, "--project") ?? null;
  const format = flag(args, "--format") ?? "json";
  const out = flag(args, "--out");
  const data = store.exportAll(project);
  db.close();

  if (format === "markdown") {
    if (!out) fail("--out <directory> is required for --format markdown");
    const files = renderVault(data);
    for (const f of files) {
      const target = join(resolve(out!), f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
    }
    console.error(`Wrote ${files.length} files to ${resolve(out!)}`);
    return;
  }
  if (format !== "json") fail(`Unknown format '${format}'. Use json or markdown.`);

  const text = JSON.stringify(data);
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, text);
    console.error(`Exported to ${resolve(out)}`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

export function importCommand(args: string[]): void {
  const file = args[0];
  if (!file) fail("Usage: task-runner-mcp import <file.json>");
  let data: ExportData;
  try {
    data = JSON.parse(readFileSync(resolve(file!), "utf8")) as ExportData;
  } catch (error) {
    return fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { store, db } = openStore();
  const result = store.importAll(data);
  db.close();
  console.error(`Imported: ${JSON.stringify(result.imported)}`);
}

// ─── projects ────────────────────────────────────────────

export function projectsCommand(args: string[]): void {
  const [action, key] = args;
  const { store, db } = openStore();
  try {
    if (!action || action === "list") {
      const rows = store.listProjects();
      for (const p of rows) {
        const stats = store.graphStats(String(p.key));
        console.log(`${p.key}\t${stats.entities} entities\t${stats.entries} notes\t${p.project_path ?? ""}`);
      }
      if (rows.length === 0) console.log("No projects yet.");
    } else if (action === "merge") {
      const into = args[2];
      if (!key || !into) fail("Usage: task-runner-mcp projects merge <from> <into> --yes");
      if (!has(args, "--yes")) fail(`This folds '${key}' into '${into}' and removes '${key}'. Re-run with --yes to confirm.`);
      console.log(JSON.stringify(store.mergeProjects(key!, into!)));
    } else if (action === "delete") {
      if (!key) fail("Usage: task-runner-mcp projects delete <key> --yes");
      if (!has(args, "--yes")) fail(`This permanently deletes all memory for '${key}'. Re-run with --yes to confirm.`);
      store.deleteProject(key!);
      console.error(`Deleted ${key}`);
    } else {
      fail("Usage: task-runner-mcp projects [list | merge <from> <into> --yes | delete <key> --yes]");
    }
  } finally {
    db.close();
  }
}

// ─── doctor ──────────────────────────────────────────────

export function doctor(): void {
  const path = defaultDbPath();
  console.log(`task-runner-mcp ${SERVER_VERSION}`);
  console.log(`node         ${process.version}`);
  console.log(`database     ${path} (${existsSync(path) ? "exists" : "will be created on first use"})`);
  try {
    const { store, db } = openStore();
    const version = db.get<{ v: string }>("SELECT sqlite_version() AS v")?.v;
    const projects = store.listProjects().length;
    const global = store.graphStats(GLOBAL_PROJECT).entities;
    console.log(`sqlite       ${version} (FTS5 ok)`);
    console.log(`projects     ${projects}`);
    console.log(`global facts ${global}`);
    const detected = detectProject(process.cwd(), (p) => store.findProjectByPath(p));
    console.log(`this folder  ${detected.project}${detected.branch ? ` @ ${detected.branch}` : ""}`);

    const byPath = new Map<string, string[]>();
    for (const p of store.listProjects()) {
      if (p.project_path) byPath.set(String(p.project_path), [...(byPath.get(String(p.project_path)) ?? []), String(p.key)]);
    }
    for (const [path, keys] of byPath) {
      if (keys.length > 1) {
        console.log(`duplicate    ${path} is recorded as ${keys.join(", ")} (fix: task-runner-mcp projects merge <from> <into> --yes)`);
      }
    }
    db.close();
  } catch (error) {
    console.log(`error        ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
