import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface DetectedProject {
  project: string;
  project_path: string;
  branch: string | null;
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

/** A committed `.task-runner.json` such as `{ "project": "extranet" }` pins the key for every clone and worktree. */
function pinnedProject(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".task-runner.json"), "utf8")) as { project?: unknown };
    return typeof parsed.project === "string" && parsed.project.trim() ? parsed.project.trim() : null;
  } catch {
    return null;
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

  const root = git(real, "rev-parse", "--show-toplevel") ?? real;
  const branch = git(real, "branch", "--show-current");
  const remote = git(real, "remote", "get-url", "origin");

  // A linked worktree shares its main checkout's key.
  const common = git(real, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const mainRoot = common && basename(common) === ".git" ? dirname(common) : root;

  const project =
    env.TASK_RUNNER_PROJECT ||
    pinnedProject(root) ||
    lookupByPath?.(root) ||
    (mainRoot !== root ? lookupByPath?.(mainRoot) : null) ||
    (remote ? keyFromRemote(remote) : null) ||
    basename(root);

  return { project, project_path: root, branch };
}
