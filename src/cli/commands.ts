import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GLOBAL_PROJECT, SERVER_VERSION } from "../core/constants.ts";
import { renderVault } from "../core/markdown.ts";
import type { StoreApi } from "../core/api.ts";
import type { ExportData } from "../core/store.ts";
import { openBackend } from "../node/backend.ts";
import { resolveProject } from "../node/project.ts";
import { defaultDbPath } from "../node/sqlite.ts";
import { deviceInfo, resolveForHook } from "../node/remote.ts";
import { formatDigest } from "./digest.ts";

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

/** Resolves the project for a directory, registering it (and the folder) on first sight. */
export async function projectFor(store: StoreApi, cwd: string) {
  const detected = await resolveProject(cwd, (p) => store.findProjectByPath(p));
  await store.setContext({ project: detected.project, project_path: detected.project_path });
  return detected;
}

// ─── hook session-start ──────────────────────────────────

export async function hookSessionStart(): Promise<void> {
  const input = stdinJson();
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  let output: Record<string, unknown>;

  try {
    // A slow server never blocks a session: memory gets a few seconds, rules fall back to the last good copy.
    const backend = openBackend({ timeoutMs: 4000 });
    const { store } = backend;
    const detected = await projectFor(store, cwd);
    const { context, status } = formatDigest(detected, await store.digest(detected.project, { branch: detected.branch }));

    const device = deviceInfo();
    if (backend.mode === "local") await backend.rules.registerDevice(device);
    const rules = await resolveForHook(backend.rules, { project: detected.project, org: detected.org, device: device.id });
    backend.close();

    const rulesNote = rules.text
      ? rules.stale ? " · rules (cached)" : " · rules"
      : rules.error ? " · rules unavailable" : "";
    const pending = rules.pending ? ` · ${rules.pending} rule proposal(s) to review` : "";
    const staleLine = rules.stale ? "\n(These rules come from the local cache: the server could not be reached.)" : "";

    output = {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: [rules.text ? rules.text + staleLine : "", context].filter(Boolean).join("\n\n"),
      },
      systemMessage: status + rulesNote + pending,
    };
  } catch (error) {
    // A broken memory store must never block a session from starting.
    output = { systemMessage: `task-runner: memory unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// ─── snapshot (feeds the live panel) ─────────────────────

export async function snapshot(args: string[]): Promise<void> {
  const cwd = resolve(flag(args, "--cwd") ?? process.cwd());
  const backend = openBackend();
  try {
    const { store } = backend;
    const detected = await projectFor(store, cwd);
    const entity = flag(args, "--entity");
    const out = entity
      ? await store.describe({ project: detected.project, name: entity, entity_type: flag(args, "--type") })
      : { ...(await store.snapshot({ project: detected.project, branch: detected.branch, query: flag(args, "--query") })), location: backend.location };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } finally {
    backend.close();
  }
}

// ─── forget / note (used by the panel and the slash commands) ──

export async function forgetCommand(args: string[]): Promise<void> {
  const name = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
  if (!name) fail("Usage: task-runner-mcp forget <name> [--type t] [--cwd dir]");
  const backend = openBackend();
  try {
    const detected = await projectFor(backend.store, resolve(flag(args, "--cwd") ?? process.cwd()));
    console.log(JSON.stringify(await backend.store.forget({ project: detected.project, name: name!, entity_type: flag(args, "--type") })));
  } finally {
    backend.close();
  }
}

export async function noteCommand(args: string[]): Promise<void> {
  const text = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))).join(" ").trim();
  if (!text) fail("Usage: task-runner-mcp note <text> [--type t] [--cwd dir]");
  const backend = openBackend();
  try {
    const detected = await projectFor(backend.store, resolve(flag(args, "--cwd") ?? process.cwd()));
    const title = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    const saved = await backend.store.saveEntry({
      project: detected.project,
      type: flag(args, "--type") ?? "note",
      title,
      content: text,
      scope: detected.branch ? "branch" : "project",
      scope_ref: detected.branch,
    });
    console.log(JSON.stringify(saved));
  } finally {
    backend.close();
  }
}

// ─── export / import ─────────────────────────────────────

export async function exportCommand(args: string[]): Promise<void> {
  const backend = openBackend({ timeoutMs: 120000 });
  const project = flag(args, "--project") ?? null;
  const format = flag(args, "--format") ?? "json";
  const out = flag(args, "--out");
  const data = await backend.store.exportAll(project);
  backend.close();

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

export async function importCommand(args: string[]): Promise<void> {
  const file = args[0];
  if (!file) fail("Usage: task-runner-mcp import <file.json>");
  let data: ExportData;
  try {
    data = JSON.parse(readFileSync(resolve(file!), "utf8")) as ExportData;
  } catch (error) {
    return fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const backend = openBackend({ timeoutMs: 300000 });
  try {
    const result = await backend.store.importAll(data);
    console.error(`Imported into ${backend.location}: ${JSON.stringify(result.imported)}`);
  } finally {
    backend.close();
  }
}

// ─── projects ────────────────────────────────────────────

export async function projectsCommand(args: string[]): Promise<void> {
  const [action, key] = args;
  const backend = openBackend();
  const { store } = backend;
  try {
    if (!action || action === "list") {
      const rows = await store.listProjects();
      for (const p of rows) {
        const stats = await store.graphStats(String(p.key));
        console.log(`${p.key}\t${stats.entities} entities\t${stats.entries} notes\t${p.project_path ?? ""}`);
      }
      if (rows.length === 0) console.log("No projects yet.");
    } else if (action === "merge") {
      const into = args[2];
      if (!key || !into) fail("Usage: task-runner-mcp projects merge <from> <into> --yes");
      if (!has(args, "--yes")) fail(`This folds '${key}' into '${into}' and removes '${key}'. Re-run with --yes to confirm.`);
      console.log(JSON.stringify(await store.mergeProjects(key!, into!)));
    } else if (action === "delete") {
      if (!key) fail("Usage: task-runner-mcp projects delete <key> --yes");
      if (!has(args, "--yes")) fail(`This permanently deletes all memory for '${key}'. Re-run with --yes to confirm.`);
      await store.deleteProject(key!);
      console.error(`Deleted ${key}`);
    } else {
      fail("Usage: task-runner-mcp projects [list | merge <from> <into> --yes | delete <key> --yes]");
    }
  } finally {
    backend.close();
  }
}

// ─── doctor ──────────────────────────────────────────────

export async function doctor(): Promise<void> {
  const path = defaultDbPath();
  console.log(`task-runner-mcp ${SERVER_VERSION}`);
  console.log(`node         ${process.version}`);
  try {
    const backend = openBackend();
    const { store } = backend;
    if (backend.mode === "local") {
      console.log(`database     ${path} (${existsSync(path) ? "exists" : "will be created on first use"})`);
      const version = backend.db.get<{ v: string }>("SELECT sqlite_version() AS v")?.v;
      console.log(`sqlite       ${version} (FTS5 ok)`);
    } else {
      console.log(`memory       ${backend.location}`);
    }
    const projects = await store.listProjects();
    console.log(`projects     ${projects.length}`);
    console.log(`global facts ${(await store.graphStats(GLOBAL_PROJECT)).entities}`);
    const detected = await resolveProject(process.cwd(), (p) => store.findProjectByPath(p));
    console.log(`this folder  ${detected.project}${detected.branch ? ` @ ${detected.branch}` : ""}${detected.org ? ` (org ${detected.org})` : ""}`);
    console.log(`this device  ${deviceInfo().label} (${deviceInfo().id})`);

    const byPath = new Map<string, string[]>();
    for (const p of projects) {
      if (p.project_path) byPath.set(String(p.project_path), [...(byPath.get(String(p.project_path)) ?? []), String(p.key)]);
    }
    for (const [dup, keys] of byPath) {
      if (keys.length > 1) {
        console.log(`duplicate    ${dup} is recorded as ${keys.join(", ")} (fix: task-runner-mcp projects merge <from> <into> --yes)`);
      }
    }
    backend.close();
  } catch (error) {
    console.log(`error        ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
