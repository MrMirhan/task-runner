import type { Store } from "../core/store.ts";
import { taskInfo, type TaskInfo } from "./compute.ts";

export interface Range {
  /** Epoch seconds, inclusive. */
  from: number;
  /** Epoch seconds, exclusive. */
  to: number;
  label: string;
}

const DAY = 86400;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

const iso = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function parseDay(text: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error(`Invalid date '${text}'. Use YYYY-MM-DD.`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Weeks start on Monday. */
export function resolveRange(
  flags: { today?: boolean; yesterday?: boolean; week?: boolean; lastWeek?: boolean; month?: boolean; days?: number; from?: string; to?: string },
  now: Date = new Date(),
): Range {
  const today = startOfDay(now);
  const secs = (d: Date) => Math.floor(d.getTime() / 1000);
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  if (flags.from || flags.to) {
    const from = flags.from ? parseDay(flags.from) : new Date(0);
    const to = addDays(flags.to ? parseDay(flags.to) : today, 1);
    return { from: secs(from), to: secs(to), label: `${flags.from ?? "start"} to ${flags.to ?? iso(today)}` };
  }
  if (flags.today) return { from: secs(today), to: secs(addDays(today, 1)), label: `Today ${iso(today)}` };
  if (flags.yesterday) {
    const y = addDays(today, -1);
    return { from: secs(y), to: secs(today), label: `Yesterday ${iso(y)}` };
  }
  if (flags.days) {
    const from = addDays(today, -(flags.days - 1));
    return { from: secs(from), to: secs(addDays(today, 1)), label: `Last ${flags.days} days` };
  }
  if (flags.month) {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: secs(first), to: secs(new Date(today.getFullYear(), today.getMonth() + 1, 1)), label: `Month ${iso(first).slice(0, 7)}` };
  }
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const start = flags.lastWeek ? addDays(monday, -7) : monday;
  const end = addDays(start, 7);
  return { from: secs(start), to: secs(end), label: `${flags.lastWeek ? "Last week" : "Week"} ${iso(start)} to ${iso(addDays(end, -1))}` };
}

export interface TaskRow extends TaskInfo {
  project: string;
  branches: string[];
  /** Seconds a person spent reading and prompting. */
  you_s: number;
  /** Seconds agents spent working, summed over parallel sessions. */
  agent_s: number;
  /** Minutes with any activity, counted once however many sessions ran. */
  wall_s: number;
  prompts: number;
  edits: number;
  days: string[];
  first_prompt: string | null;
  notes?: Array<{ type: string; title: string; at: string }>;
  task_groups?: Array<{ name: string; done: number; total: number }>;
}

export interface Report {
  range: Range;
  rows: TaskRow[];
  days: Array<{ day: string; you_s: number; agent_s: number; wall_s: number }>;
  totals: { you_s: number; agent_s: number; wall_s: number; projects: number; tasks: number; prompts: number; edits: number };
}

export function buildReport(
  store: Store,
  input: { range: Range; project?: string | null; exclude?: string[]; detail?: boolean; detailLimit?: number },
): Report {
  const { perDay, facts, wall_s } = store.worklogRows({ from: input.range.from, to: input.range.to, project: input.project, exclude: input.exclude });

  const byTask = new Map<string, TaskRow>();
  const rowFor = (project: string, branch: string): TaskRow => {
    const info = taskInfo(branch);
    const key = `${project}\u0000${info.label}`;
    let row = byTask.get(key);
    if (!row) {
      row = { ...info, project, branches: [], you_s: 0, agent_s: 0, wall_s: 0, prompts: 0, edits: 0, days: [], first_prompt: null };
      byTask.set(key, row);
    }
    if (!row.branches.includes(branch)) row.branches.push(branch);
    return row;
  };

  const days = new Map<string, { day: string; you_s: number; agent_s: number; wall_s: number }>();
  for (const r of perDay) {
    const row = rowFor(r.project_key, r.branch);
    row.you_s += r.human_s;
    row.agent_s += r.ai_s;
    row.wall_s += r.wall_s;
    if (!row.days.includes(r.day)) row.days.push(r.day);
    const d = days.get(r.day) ?? { day: r.day, you_s: 0, agent_s: 0, wall_s: 0 };
    d.you_s += r.human_s;
    d.agent_s += r.ai_s;
    d.wall_s += r.wall_s;
    days.set(r.day, d);
  }
  for (const f of facts) {
    const row = rowFor(f.project_key, f.branch);
    row.prompts += f.prompts;
    row.edits += f.edits;
    if (!row.first_prompt && f.first_prompt) row.first_prompt = f.first_prompt;
  }

  const rows = [...byTask.values()]
    .filter((r) => r.you_s + r.agent_s > 0 || r.prompts > 0)
    .sort((a, b) => b.you_s + b.agent_s - (a.you_s + a.agent_s));

  if (input.detail) {
    for (const row of rows.slice(0, input.detailLimit ?? 15)) {
      const notes: NonNullable<TaskRow["notes"]> = [];
      const groups: NonNullable<TaskRow["task_groups"]> = [];
      for (const branch of row.branches) {
        const found = store.worklogActivity(row.project, branch, input.range.from, input.range.to);
        for (const n of found.notes) notes.push({ type: n.type, title: n.title, at: new Date(n.created_at * 1000).toISOString().slice(0, 10) });
        for (const g of found.groups) groups.push({ name: g.task_group, done: g.completed, total: g.total });
      }
      row.notes = notes;
      row.task_groups = groups;
    }
  }

  return {
    range: input.range,
    rows,
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    totals: {
      you_s: rows.reduce((n, r) => n + r.you_s, 0),
      agent_s: rows.reduce((n, r) => n + r.agent_s, 0),
      wall_s,
      projects: new Set(rows.map((r) => r.project)).size,
      tasks: rows.length,
      prompts: rows.reduce((n, r) => n + r.prompts, 0),
      edits: rows.reduce((n, r) => n + r.edits, 0),
    },
  };
}

// ─── Rendering ────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return seconds > 0 ? "<1m" : "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

const pad = (text: string, width: number, right = false) =>
  right ? text.padStart(width) : text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

export function renderText(report: Report, options: { detail?: boolean } = {}): string {
  const { totals: t } = report;
  const lines = [
    report.range.label,
    `You ${formatDuration(t.you_s)} · agent ${formatDuration(t.agent_s)} · wall clock ${formatDuration(t.wall_s)} · ${t.tasks} tasks in ${t.projects} projects`,
    "(agent time adds up across parallel sessions; wall clock counts each minute once)",
    "",
  ];
  if (report.rows.length === 0) return [...lines, "No activity in this range."].join("\n");

  lines.push(`${pad("PROJECT", 24)} ${pad("TASK", 26)} ${pad("KIND", 8)} ${pad("YOU", 8, true)} ${pad("AGENT", 8, true)} ${pad("WALL", 8, true)} ${pad("PROMPTS", 7, true)} ${pad("EDITS", 5, true)}`);
  for (const r of report.rows) {
    lines.push(
      `${pad(r.project, 24)} ${pad(r.label, 26)} ${pad(r.kind, 8)} ${pad(formatDuration(r.you_s), 8, true)} ${pad(formatDuration(r.agent_s), 8, true)} ${pad(formatDuration(r.wall_s), 8, true)} ${pad(String(r.prompts), 7, true)} ${pad(String(r.edits), 5, true)}`,
    );
    if (options.detail) {
      if (r.first_prompt) lines.push(`    asked: ${r.first_prompt}`);
      for (const g of r.task_groups ?? []) lines.push(`    tasks: ${g.name} ${g.done}/${g.total}`);
      for (const n of r.notes ?? []) lines.push(`    ${n.at} [${n.type}] ${n.title}`);
    }
  }
  return lines.join("\n");
}

export function renderMarkdown(report: Report): string {
  const { totals: t } = report;
  const out = [
    `# Worklog: ${report.range.label}`,
    "",
    `- You: **${formatDuration(t.you_s)}**`,
    `- Agent: **${formatDuration(t.agent_s)}** (adds up across parallel sessions)`,
    `- Wall clock: **${formatDuration(t.wall_s)}**`,
    `- ${t.tasks} tasks in ${t.projects} projects, ${t.prompts} prompts, ${t.edits} file edits`,
    "",
  ];
  const projects = [...new Set(report.rows.map((r) => r.project))];
  for (const project of projects) {
    const rows = report.rows.filter((r) => r.project === project);
    out.push(`## ${project}`, "");
    for (const r of rows) {
      out.push(`### ${r.label} (${r.kind})`, "", `You ${formatDuration(r.you_s)} · agent ${formatDuration(r.agent_s)} · wall ${formatDuration(r.wall_s)} · ${r.days.join(", ")}`, "");
      if (r.first_prompt) out.push(`Started from: "${r.first_prompt}"`, "");
      for (const g of r.task_groups ?? []) out.push(`- Task group \`${g.name}\`: ${g.done}/${g.total} done`);
      for (const n of r.notes ?? []) out.push(`- ${n.at} [${n.type}] ${n.title}`);
      if ((r.notes?.length ?? 0) + (r.task_groups?.length ?? 0) > 0) out.push("");
    }
  }
  return out.join("\n");
}

const csvCell = (value: unknown): string => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** One line per day, project and task: ready for a spreadsheet or a time-tracking import. */
export function renderCsv(store: Store, input: { range: Range; project?: string | null; exclude?: string[] }): string {
  const { perDay } = store.worklogRows({ from: input.range.from, to: input.range.to, project: input.project, exclude: input.exclude });
  const lines = ["day,project,task,kind,branch,you_minutes,agent_minutes,wall_minutes,you_hours,agent_hours"];
  for (const r of perDay) {
    const info = taskInfo(r.branch);
    const hours = (s: number) => (s / 3600).toFixed(2);
    lines.push(
      [r.day, r.project_key, info.label, info.kind, r.branch, Math.round(r.human_s / 60), Math.round(r.ai_s / 60), Math.round(r.wall_s / 60), hours(r.human_s), hours(r.ai_s)]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
