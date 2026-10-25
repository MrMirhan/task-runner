/** `system` is a user-role message nobody typed: a task notification, another session, an injected skill. */
export type EventKind = "prompt" | "assistant" | "tool_result" | "system";

export interface RawEvent {
  /** Epoch seconds. */
  t: number;
  kind: EventKind;
  cwd: string | null;
  branch: string | null;
  sessionId: string;
  /** Prompt text, only for human prompts. */
  text?: string;
  /** Number of file-editing tool calls in an assistant event. */
  edits?: number;
  /** Files the event's tool calls touched: where the agent really worked when the session started elsewhere. */
  paths?: string[];
}

export interface Resolvers {
  /** The project of a working directory, and whether that directory is inside a git repository. */
  cwd(cwd: string | null): { project: string; isRepo: boolean };
  /** The project of a file, or null when it is not inside a known git repository. */
  path(file: string): string | null;
}

export interface WorklogOptions {
  /** Longest wait before a human prompt that still counts as the human's time. */
  humanCapSeconds: number;
  /** Longest stretch between two agent events that still counts as the agent working. */
  aiCapSeconds: number;
}

export const DEFAULT_OPTIONS: WorklogOptions = { humanCapSeconds: 5 * 60, aiCapSeconds: 15 * 60 };

export interface Scope {
  project: string;
  branch: string;
}

export interface MinuteRow extends Scope {
  sessionId: string;
  minute: number;
  kind: "ai" | "human";
  secs: number;
}

export interface FactRow extends Scope {
  day: string;
  prompts: number;
  edits: number;
  firstPrompt: string | null;
}

const NO_BRANCH = "(none)";

export function localDay(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function normalizeBranch(branch: string | null | undefined): string {
  return branch && branch !== "HEAD" ? branch : NO_BRANCH;
}

/**
 * Turns one session's events into per-minute time rows.
 *
 * Between two events the gap belongs to whoever was working: when the next event is a human
 * prompt, the gap was the human reading and thinking (charged to the project they were looking at);
 * otherwise the agent was working (charged to the project it worked in). A gap is capped, because
 * a longer one is a break, not work.
 */
export function computeWorklog(
  events: RawEvent[],
  resolvers: Resolvers,
  options: WorklogOptions = DEFAULT_OPTIONS,
): { minutes: MinuteRow[]; facts: FactRow[] } {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const minutes = new Map<string, MinuteRow>();
  const facts = new Map<string, FactRow>();

  // A session started in a plain folder (say, the parent of several repos) still works in a repo:
  // follow the files it touches. The part before the first touch belongs to that first repo too.
  const focusAt: Array<string | null> = [];
  let focus: string | null = null;
  for (const e of sorted) {
    for (const file of e.paths ?? []) focus = resolvers.path(file) ?? focus;
    focusAt.push(focus);
  }
  const firstFocus = focusAt.find((f) => f !== null) ?? null;
  const index = new Map<RawEvent, number>(sorted.map((e, i) => [e, i]));

  const scopeOf = (e: RawEvent): Scope => {
    const here = resolvers.cwd(e.cwd);
    if (here.isRepo) return { project: here.project, branch: normalizeBranch(e.branch) };
    const followed = focusAt[index.get(e) ?? 0] ?? firstFocus;
    return { project: followed ?? here.project, branch: followed ? NO_BRANCH : normalizeBranch(e.branch) };
  };

  const addSeconds = (end: number, seconds: number, kind: "ai" | "human", scope: Scope, sessionId: string) => {
    let from = end - seconds;
    while (from < end - 0.5) {
      const minute = Math.floor(from / 60);
      const next = Math.min(end, (minute + 1) * 60);
      const secs = Math.round(next - from);
      if (secs > 0) {
        const key = `${minute}|${kind}|${scope.project}|${scope.branch}`;
        const row = minutes.get(key);
        if (row) row.secs += secs;
        else minutes.set(key, { sessionId, minute, kind, ...scope, secs });
      }
      from = next;
    }
  };

  const fact = (e: RawEvent): FactRow => {
    const scope = scopeOf(e);
    const day = localDay(e.t);
    const key = `${day}|${scope.project}|${scope.branch}`;
    let row = facts.get(key);
    if (!row) {
      row = { day, ...scope, prompts: 0, edits: 0, firstPrompt: null };
      facts.set(key, row);
    }
    return row;
  };

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    if (current.kind === "prompt") {
      const row = fact(current);
      row.prompts += 1;
      if (!row.firstPrompt && current.text) row.firstPrompt = current.text;
    }
    if (current.edits) fact(current).edits += current.edits;

    if (i === 0) continue;
    const previous = sorted[i - 1];
    const gap = current.t - previous.t;
    if (gap <= 0) continue;

    // Nothing was working while a system message was on its way, so that gap is idle time.
    if (current.kind === "system") continue;

    if (current.kind === "prompt") {
      addSeconds(current.t, Math.min(gap, options.humanCapSeconds), "human", scopeOf(previous), current.sessionId);
    } else {
      addSeconds(current.t, Math.min(gap, options.aiCapSeconds), "ai", scopeOf(current), current.sessionId);
    }
  }

  return { minutes: [...minutes.values()], facts: [...facts.values()] };
}

export interface TaskInfo {
  label: string;
  kind: "feature" | "fix" | "chore" | "other";
}

const TICKET = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?:[^A-Za-z0-9]|$)/;

/** A branch is one task. A ticket key inside the name wins as the label; the prefix tells feature from fix. */
export function taskInfo(branch: string): TaskInfo {
  if (branch === NO_BRANCH || branch === "main" || branch === "master" || branch === "develop") {
    return { label: branch === NO_BRANCH ? "(no branch)" : branch, kind: "other" };
  }
  const ticket = TICKET.exec(branch)?.[1];
  const head = branch.split("/")[0].toLowerCase();
  const kind: TaskInfo["kind"] = /^(feat|feature)$/.test(head)
    ? "feature"
    : /^(fix|bugfix|hotfix)$/.test(head)
      ? "fix"
      : /^(chore|refactor|docs|test|ci|build|perf|style)$/.test(head)
        ? "chore"
        : "other";
  return { label: ticket ? ticket.toUpperCase() : branch, kind };
}
