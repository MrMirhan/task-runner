import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface DetectedProject {
  project: string;
  project_path: string;
  branch: string | null;
  /** Owner of the git remote (or the pinned `org`), lowercase: the organization the project belongs to. */
  org: string | null;
  /** False when the folder is not inside a git repository. */
  is_repo: boolean;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** `git@github.com:owner/repo.git` and `https://host/owner/repo` both become `owner-repo`, lowercased. */
export function keyFromRemote(url: string): string | null {
  const parts = url
    .trim()
    .replace(/\.git$/, "")
    .split(/[/:]+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}-${parts[parts.length - 1]}`.toLowerCase();
}

export function ownerFromRemote(url: string): string | null {
  const parts = url.trim().replace(/\.git$/, "").split(/[/:]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : null;
}

/** A committed `.task-runner.json` such as `{ "project": "storefront", "org": "acme" }` pins the key for every clone and worktree. */
function pinned(root: string): { project: string | null; org: string | null } {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".task-runner.json"), "utf8")) as { project?: unknown; org?: unknown };
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { project: pick(parsed.project), org: pick(parsed.org) };
  } catch {
    return { project: null, org: null };
  }
}

/**
 * Resolves the project a directory belongs to. Order: environment, pinned file, a project
 * already recorded for the same path, the git remote, the folder name. A codebase therefore
 * keeps one key across clones, worktrees and renames.
 */
export function detectProject(
  cwd: string,
  lookupByPath?: (path: string) => string | null,
  env: NodeJS.ProcessEnv = process.env,
): DetectedProject {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // keep the path as given
  }

  const top = git(real, "rev-parse", "--show-toplevel");
  const root = top ?? real;
  const branch = git(real, "branch", "--show-current");
  const remote = git(real, "remote", "get-url", "origin");

  // A linked worktree shares its main checkout's key.
  const common = git(real, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const mainRoot = common && basename(common) === ".git" ? dirname(common) : root;

  const pin = pinned(root);
  const project =
    env.TASK_RUNNER_PROJECT ||
    pin.project ||
    lookupByPath?.(root) ||
    (mainRoot !== root ? lookupByPath?.(mainRoot) : null) ||
    (remote ? keyFromRemote(remote) : null) ||
    basename(root);

  const org = env.TASK_RUNNER_ORG || pin.org || (remote ? ownerFromRemote(remote) : null);

  return { project, project_path: root, branch, org, is_repo: top !== null };
}

/** detectProject for a store that answers asynchronously (the server). */
export async function resolveProject(
  cwd: string,
  lookupByPath: (path: string) => Promise<string | null> | string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DetectedProject> {
  // Collect the paths the sync detector would look up, then answer them in one go.
  const asked: string[] = [];
  detectProject(cwd, (p) => {
    asked.push(p);
    return null;
  }, env);
  const answers = new Map<string, string | null>();
  for (const p of asked) answers.set(p, await lookupByPath(p));
  return detectProject(cwd, (p) => answers.get(p) ?? null, env);
}
