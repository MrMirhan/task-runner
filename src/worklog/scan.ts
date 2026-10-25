import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Store } from "../core/store.ts";
import { detectProject } from "../node/project.ts";
import { computeWorklog, DEFAULT_OPTIONS, type RawEvent, type Resolvers, type WorklogOptions } from "./compute.ts";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_TOOLS = new Set([...EDIT_TOOLS, "Read"]);
const SETTING_KEY = "worklog_options";

export function transcriptRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

interface TranscriptFile {
  path: string;
  size: number;
  mtime: number;
}

export function listTranscripts(root: string, sinceDays: number | null): TranscriptFile[] {
  const cutoff = sinceDays === null ? 0 : Date.now() / 1000 - sinceDays * 86400;
  const out: TranscriptFile[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.mtimeMs / 1000 < cutoff) continue;
        out.push({ path, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      } catch {
        // file vanished between listing and stat
      }
    }
  }
  return out;
}

const clipText = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const FIELD = new Map<string, RegExp>();
const field = (line: string, name: string): string | null => {
  let re = FIELD.get(name);
  if (!re) {
    re = new RegExp(`"${name}":"([^"\\\\]*)"`);
    FIELD.set(name, re);
  }
  const m = re.exec(line);
  return m ? m[1] : null;
};

/**
 * Tool results are the bulk of a transcript and can be megabytes each. Only their envelope matters,
 * and the envelope fields sit outside the quoted payload, where an unescaped match is unambiguous.
 */
function parseToolResult(line: string): RawEvent | null {
  if (line.includes('"isSidechain":true')) return null;
  const stamp = field(line, "timestamp");
  const t = stamp ? Date.parse(stamp) / 1000 : NaN;
  if (!Number.isFinite(t)) return null;
  return { t, kind: "tool_result", cwd: field(line, "cwd"), branch: field(line, "gitBranch"), sessionId: field(line, "sessionId") ?? "unknown" };
}

function parseLine(line: string): RawEvent | null {
  if (line.includes('"type":"tool_result"') && line.includes('"type":"user"')) return parseToolResult(line);
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return null;
  let d: Record<string, any>;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d.isSidechain || (d.type !== "user" && d.type !== "assistant") || typeof d.timestamp !== "string") return null;
  const t = Date.parse(d.timestamp) / 1000;
  if (!Number.isFinite(t)) return null;

  const base = {
    t,
    cwd: typeof d.cwd === "string" ? d.cwd : null,
    branch: typeof d.gitBranch === "string" ? d.gitBranch : null,
    sessionId: typeof d.sessionId === "string" ? d.sessionId : "unknown",
  };
  const content = d.message?.content;

  if (d.type === "assistant") {
    const uses = Array.isArray(content) ? content.filter((c: any) => c?.type === "tool_use") : [];
    const edits = uses.filter((c: any) => EDIT_TOOLS.has(c.name)).length;
    const paths = uses
      .filter((c: any) => FILE_TOOLS.has(c.name))
      .map((c: any) => c.input?.file_path ?? c.input?.notebook_path)
      .filter((p: unknown): p is string => typeof p === "string" && p.startsWith("/"));
    return { ...base, kind: "assistant", edits, ...(paths.length ? { paths } : {}) };
  }

  if (Array.isArray(content) && content.some((c: any) => c?.type === "tool_result")) {
    return { ...base, kind: "tool_result" };
  }
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join(" ")
      : "";
  const isHuman = d.origin?.kind === "human" && !d.isMeta && text.trim() !== "" && !text.trimStart().startsWith("<");
  return isHuman ? { ...base, kind: "prompt", text: clipText(text, 160) } : { ...base, kind: "system" };
}

const LARGE_LINE = 64 * 1024;

async function* bufferLines(path: string): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) {
        parts.push(chunk.subarray(start));
        break;
      }
      parts.push(chunk.subarray(start, nl));
      yield parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      start = nl + 1;
    }
  }
  if (parts.length > 0) yield Buffer.concat(parts);
}

/**
 * Transcripts hold screenshots and tool output as lines of many megabytes. Decoding those is the
 * whole cost of a scan, and only their envelope matters: the type sits at the start of the line
 * and the timestamp, origin, folder and branch at its end.
 */
function parseBuffer(line: Buffer): RawEvent | null {
  if (line.length <= LARGE_LINE) return parseLine(line.toString("utf8"));
  const head = line.toString("utf8", 0, 800);
  if (head.includes('"type":"assistant"')) return parseLine(line.toString("utf8"));
  if (!head.includes('"type":"user"')) return null;
  const tail = line.toString("utf8", line.length - 2000);
  const both = `${head} ${tail}`;
  if (head.includes('"type":"tool_result"')) return parseToolResult(both);
  const envelope = parseToolResult(both);
  if (!envelope) return null;
  return both.includes('"origin":{"kind":"human"}')
    ? { ...envelope, kind: "prompt", text: "(attachment)" }
    : { ...envelope, kind: "system" };
}

async function readEvents(path: string): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  for await (const line of bufferLines(path)) {
    const event = parseBuffer(line);
    if (event) events.push(event);
  }
  return events;
}

const SCRATCH = /\/scratchpad(\/|$)|\/tmp\/claude-|Application Support\/Claude|\/private\/tmp\//;

function existingAncestor(path: string): string | null {
  let dir = path;
  for (let i = 0; i < 40; i++) {
    if (existsSync(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Maps folders and files to project keys, also for folders that were deleted since (worktrees, scratch dirs). */
export function makeResolvers(store: Store): Resolvers {
  const byCwd = new Map<string, { project: string; isRepo: boolean }>();
  const byDir = new Map<string, string | null>();
  // Repo roots seen so far: any file below one needs no git call.
  const roots: Array<{ root: string; project: string }> = [];

  // An empty environment: TASK_RUNNER_PROJECT must not relabel every folder in the history.
  const detect = (dir: string) => detectProject(dir, (p) => store.findProjectByPath(p), {});

  const fromMissing = (cwd: string): { project: string; isRepo: boolean } => {
    const known = store.findProjectByPath(cwd);
    if (known) return { project: known, isRepo: true };
    const orca = /\/orca\/workspaces\/([^/]+)\/[^/]+/.exec(cwd);
    if (orca) {
      const prefix = `${cwd.slice(0, (orca.index ?? 0) + orca[0].lastIndexOf("/"))}/`;
      return { project: store.findProjectByPathPrefix(prefix) ?? orca[1], isRepo: true };
    }
    if (SCRATCH.test(cwd)) return { project: "(scratch)", isRepo: false };
    const ancestor = existingAncestor(cwd);
    if (ancestor) {
      const found = detect(ancestor);
      if (found.is_repo) return { project: found.project, isRepo: true };
    }
    return { project: basename(cwd), isRepo: false };
  };

  return {
    cwd(cwd) {
      if (!cwd) return { project: "(unknown)", isRepo: false };
      let hit = byCwd.get(cwd);
      if (!hit) {
        if (existsSync(cwd)) {
          const found = detect(cwd);
          hit = SCRATCH.test(cwd) && !found.is_repo ? { project: "(scratch)", isRepo: false } : { project: found.project, isRepo: found.is_repo };
        } else {
          hit = fromMissing(cwd);
        }
        byCwd.set(cwd, hit);
      }
      return hit;
    },
    path(file) {
      const dir = dirname(file);
      if (byDir.has(dir)) return byDir.get(dir) ?? null;
      const known = roots.find((r) => file.startsWith(`${r.root}/`));
      if (known) {
        byDir.set(dir, known.project);
        return known.project;
      }
      const ancestor = existingAncestor(dir);
      let project: string | null = null;
      if (ancestor) {
        const found = detect(ancestor);
        if (found.is_repo && !SCRATCH.test(found.project_path)) {
          project = found.project;
          roots.push({ root: found.project_path, project });
        }
      } else {
        const missing = fromMissing(dir);
        if (missing.isRepo) project = missing.project;
      }
      byDir.set(dir, project);
      return project;
    },
  };
}

export interface ScanResult {
  scanned: number;
  skipped: number;
}

export async function scanWorklog(
  store: Store,
  input: { sinceDays?: number | null; options?: WorklogOptions; root?: string; onFile?: (path: string) => void } = {},
): Promise<ScanResult> {
  const options = input.options ?? DEFAULT_OPTIONS;
  const signature = `${options.humanCapSeconds}:${options.aiCapSeconds}:1`;
  if (store.worklogSetting(SETTING_KEY) !== signature) {
    store.clearWorklog();
    store.setWorklogSetting(SETTING_KEY, signature);
  }

  const resolvers = makeResolvers(store);
  const result: ScanResult = { scanned: 0, skipped: 0 };
  const sinceDays = input.sinceDays === undefined ? 120 : input.sinceDays;

  for (const file of listTranscripts(input.root ?? transcriptRoot(), sinceDays)) {
    const known = store.worklogFileState(file.path);
    if (known && known.size === file.size && known.mtime === file.mtime) {
      result.skipped++;
      continue;
    }
    input.onFile?.(file.path);
    const events = await readEvents(file.path);
    const { minutes, facts } = computeWorklog(events, resolvers, options);
    store.replaceWorklogFile(file.path, file.size, file.mtime, minutes, facts);
    result.scanned++;
  }
  return result;
}
