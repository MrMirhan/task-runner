"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { apiUrl, errorMessage, fetchApiSignal, qs } from "../lib/api";
import { formatWorkTime } from "../lib/format";
import type { Project, WorklogDay, WorklogKind, WorklogReport, WorklogRow, WorklogRangeKey } from "../lib/types";
import { GLOBAL_PROJECT, projectLabel } from "../lib/types";

interface Props {
  projects: Project[];
  refreshKey: number;
}

const RANGES: Array<{ key: WorklogRangeKey; label: string }> = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "last-week", label: "Last week" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom" },
];

const RANGE_STORAGE = "task-runner-time-range";
const SLOW_AFTER_MS = 2000;
const COLUMNS = 7;

const KIND_COLOR: Record<WorklogKind, string> = {
  feature: "text-info",
  fix: "text-warn",
  chore: "text-muted",
  other: "text-muted",
};

type SortKey = "you_s" | "agent_s" | "wall_s";
interface Sort {
  key: SortKey | null;
  dir: "asc" | "desc";
}

interface Saved {
  range: WorklogRangeKey;
  from: string;
  to: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dayLabel(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function loadSaved(): Partial<Saved> {
  try {
    const raw = localStorage.getItem(RANGE_STORAGE);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== "object") return {};
    const d = data as Record<string, unknown>;
    const out: Partial<Saved> = {};
    if (typeof d.range === "string" && RANGES.some((r) => r.key === d.range)) out.range = d.range as WorklogRangeKey;
    if (typeof d.from === "string") out.from = d.from;
    if (typeof d.to === "string") out.to = d.to;
    return out;
  } catch {
    return {};
  }
}

function save(value: Saved) {
  try {
    localStorage.setItem(RANGE_STORAGE, JSON.stringify(value));
  } catch {
    // storage can be blocked; the choice just won't persist
  }
}

/** Fills days without activity so the chart shows the whole range. Skips open-ended ranges. */
function chartDays(report: WorklogReport): WorklogDay[] {
  const byDay = new Map(report.days.map((d) => [d.day, d]));
  const span = (report.range.to - report.range.from) / 86400;
  if (span <= 0 || span > 62) return report.days;
  const out: WorklogDay[] = [];
  const last = Math.min(report.range.to * 1000 - 1, Date.now());
  for (let t = new Date(report.range.from * 1000); t.getTime() <= last; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) {
    const key = isoDay(t);
    out.push(byDay.get(key) ?? { day: key, you_s: 0, agent_s: 0, wall_s: 0 });
  }
  for (const d of report.days) if (!out.some((o) => o.day === d.day)) out.push(d);
  return out.sort((a, b) => a.day.localeCompare(b.day));
}

const rowId = (r: WorklogRow) => `${r.project}\u0000${r.label}`;

function summaryMarkdown(report: WorklogReport, groups: Array<{ project: string; name: string; rows: WorklogRow[] }>): string {
  const t = report.totals;
  const lines = [
    `# Time report: ${report.range.label}`,
    "",
    `You ${formatWorkTime(t.you_s)}, agent ${formatWorkTime(t.agent_s)}, wall clock ${formatWorkTime(t.wall_s)}. ${t.tasks} ${t.tasks === 1 ? "task" : "tasks"} in ${t.projects} ${t.projects === 1 ? "project" : "projects"}.`,
  ];
  for (const g of groups) {
    lines.push("", `## ${g.name}`, "");
    for (const r of g.rows) {
      lines.push(`- ${r.label} (${r.kind}): you ${formatWorkTime(r.you_s)}, agent ${formatWorkTime(r.agent_s)}, wall ${formatWorkTime(r.wall_s)}`);
    }
  }
  lines.push("", `Total: you ${formatWorkTime(t.you_s)}, agent ${formatWorkTime(t.agent_s)}, wall clock ${formatWorkTime(t.wall_s)}`);
  return lines.join("\n");
}

export default function TimeView({ projects, refreshKey }: Props) {
  const today = useMemo(() => isoDay(new Date()), []);
  const [range, setRange] = useState<WorklogRangeKey>("week");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [hydrated, setHydrated] = useState(false);
  const [project, setProject] = useState("");
  const [retry, setRetry] = useState(0);

  const [report, setReport] = useState<WorklogReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seenProjects, setSeenProjects] = useState<string[]>([]);

  const [sort, setSort] = useState<Sort>({ key: null, dir: "desc" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    const saved = loadSaved();
    if (saved.range) setRange(saved.range);
    if (saved.from) setFrom(saved.from);
    if (saved.to) setTo(saved.to);
    setHydrated(true);
  }, []);

  const customInvalid =
    range === "custom" ? (!from || !to ? "Pick both dates." : from > to ? "The start date is after the end date." : null) : null;

  const query = useMemo(
    () => qs({ range, from: range === "custom" ? from : null, to: range === "custom" ? to : null, project }),
    [range, from, to, project],
  );

  useEffect(() => {
    if (!hydrated) return;
    setOpen(new Set());
    setCopyState("idle");
    if (customInvalid) {
      setReport(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setSlow(false);
    setError(null);
    setReport(null);
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    fetchApiSignal<WorklogReport>(`/worklog${query}${query ? "&" : "?"}detail=true`, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setReport(d);
        setSeenProjects((prev) => [...new Set([...prev, ...d.rows.map((r) => r.project)])]);
        setLoading(false);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(e));
        setLoading(false);
      })
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [hydrated, query, customInvalid, refreshKey, retry]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const t = setTimeout(() => setCopyState("idle"), 2500);
    return () => clearTimeout(t);
  }, [copyState]);

  function chooseRange(next: WorklogRangeKey) {
    setRange(next);
    save({ range: next, from, to });
  }

  function chooseDate(kind: "from" | "to", value: string) {
    const nextFrom = kind === "from" ? value : from;
    const nextTo = kind === "to" ? value : to;
    if (kind === "from") setFrom(value);
    else setTo(value);
    save({ range, from: nextFrom, to: nextTo });
  }

  function toggleSort(key: SortKey) {
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  }

  function toggleRow(id: string) {
    setOpen((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const nameFor = useMemo(() => {
    const byKey = new Map(projects.map((p) => [p.key, p]));
    return (key: string) => {
      const p = byKey.get(key);
      return p ? projectLabel(p, projects) : key;
    };
  }, [projects]);

  const filterOptions = useMemo(() => {
    const keys = new Set(projects.filter((p) => p.key !== GLOBAL_PROJECT).map((p) => p.key));
    for (const k of seenProjects) keys.add(k);
    if (project) keys.add(project);
    return [...keys].map((key) => ({ key, name: nameFor(key) })).sort((a, b) => a.name.localeCompare(b.name));
  }, [projects, seenProjects, project, nameFor]);

  const groups = useMemo(() => {
    if (!report) return [];
    const by = new Map<string, WorklogRow[]>();
    for (const r of report.rows) {
      const list = by.get(r.project) ?? [];
      list.push(r);
      by.set(r.project, list);
    }
    const total = (rows: WorklogRow[]) => rows.reduce((n, r) => n + r.you_s + r.agent_s, 0);
    return [...by.entries()]
      .map(([key, rows]) => {
        const sorted = sort.key
          ? [...rows].sort((a, b) => (sort.dir === "desc" ? b[sort.key!] - a[sort.key!] : a[sort.key!] - b[sort.key!]))
          : rows;
        return { project: key, name: nameFor(key), rows: sorted };
      })
      .sort((a, b) => total(b.rows) - total(a.rows));
  }, [report, sort, nameFor]);

  async function copySummary() {
    if (!report) return;
    const text = summaryMarkdown(report, groups);
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const csvHref = apiUrl(`/worklog.csv${query}`);
  const chart = report ? chartDays(report) : [];
  const chartMax = Math.max(1, ...chart.map((d) => d.you_s + d.agent_s));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => chooseRange(r.key)}
              aria-pressed={range === r.key}
              className={`btn ${range === r.key ? "!border-link !text-link" : ""}`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="time-from" className="mb-1 block text-xs uppercase tracking-wide text-muted">
                From
              </label>
              <input
                id="time-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => chooseDate("from", e.target.value)}
                className="field w-auto"
              />
            </div>
            <div>
              <label htmlFor="time-to" className="mb-1 block text-xs uppercase tracking-wide text-muted">
                To
              </label>
              <input
                id="time-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => chooseDate("to", e.target.value)}
                className="field w-auto"
              />
            </div>
          </div>
        )}

        <div>
          <label htmlFor="time-project" className="mb-1 block text-xs uppercase tracking-wide text-muted">
            Project
          </label>
          <select
            id="time-project"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="field w-auto min-w-[10rem] max-w-[16rem]"
          >
            <option value="">All projects</option>
            {filterOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={copySummary} disabled={!report || report.rows.length === 0} className="btn">
            Copy summary
          </button>
          {customInvalid ? (
            <span className="btn cursor-not-allowed opacity-55" aria-disabled="true">
              Download CSV
            </span>
          ) : (
            <a href={csvHref} download className="btn">
              Download CSV
            </a>
          )}
        </div>
      </div>

      <div role="status" aria-live="polite" className="min-h-4 text-xs text-muted">
        {copyState === "copied" && <p className="text-ok">Summary copied to the clipboard.</p>}
        {copyState === "failed" && <p>The browser blocked clipboard access. Select the text below and copy it.</p>}
        {loading && slow && <p>Reading session transcripts, the first run can take a minute…</p>}
      </div>

      {copyState === "failed" && report && (
        <textarea
          readOnly
          aria-label="Summary in Markdown"
          value={summaryMarkdown(report, groups)}
          onFocus={(e) => e.currentTarget.select()}
          rows={8}
          className="field font-mono text-xs"
        />
      )}

      {customInvalid ? (
        <p className="py-8 text-center text-sm text-muted" role="alert">
          {customInvalid}
        </p>
      ) : error ? (
        <div className="py-8 text-center">
          <p className="text-sm text-bad" role="alert">
            {error}
          </p>
          <button type="button" onClick={() => setRetry((n) => n + 1)} className="btn btn-primary mt-4">
            Retry
          </button>
        </div>
      ) : loading || !report ? (
        <Skeleton />
      ) : report.rows.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted">No activity in this range.</p>
          <p className="mx-auto mt-2 max-w-md text-xs text-muted">Time is read from your Claude Code session transcripts.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted">{report.range.label}</p>

          <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Card label="You" value={formatWorkTime(report.totals.you_s)} color="text-info" />
            <Card label="Agent" value={formatWorkTime(report.totals.agent_s)} color="text-warn" />
            <Card label="Wall clock" value={formatWorkTime(report.totals.wall_s)} color="text-fg" />
            <Card label="Tasks" value={String(report.totals.tasks)} color="text-fg" />
            <Card label="Prompts" value={String(report.totals.prompts)} color="text-fg" />
            <Card label="File edits" value={String(report.totals.edits)} color="text-fg" />
          </dl>
          <p className="text-xs text-muted">
            You is time spent reading and prompting. Agent is time agents worked, added up over parallel sessions. Wall clock counts
            each minute once.
          </p>

          <section aria-labelledby="time-days">
            <h2 id="time-days" className="section-title">
              Per day
            </h2>
            <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted" aria-hidden="true">
              <span className="flex items-center gap-1.5">
                <span className="bar-you inline-block h-3 w-5 rounded-sm" /> You
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bar-agent inline-block h-3 w-5 rounded-sm" /> Agent
              </span>
            </div>
            <ul className="space-y-1.5">
              {chart.map((d) => (
                <li key={d.day} className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-0.5 md:grid-cols-[7.5rem_1fr_19rem]">
                  <span className="text-xs">{dayLabel(d.day)}</span>
                  <span className="flex h-3 overflow-hidden rounded-sm bg-raised" aria-hidden="true">
                    <span className="bar-you block h-full" style={{ width: `${(d.you_s / chartMax) * 100}%` }} />
                    <span className="bar-agent block h-full" style={{ width: `${(d.agent_s / chartMax) * 100}%` }} />
                  </span>
                  <span className="col-start-2 text-xs tabular-nums text-muted md:col-start-3">
                    <span className="whitespace-nowrap">You {formatWorkTime(d.you_s)}</span> ·{" "}
                    <span className="whitespace-nowrap">Agent {formatWorkTime(d.agent_s)}</span> ·{" "}
                    <span className="whitespace-nowrap">Wall {formatWorkTime(d.wall_s)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="time-tasks">
            <h2 id="time-tasks" className="section-title">
              Tasks
            </h2>
            <div className="relative overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <thead>
                  <tr className="bg-raised text-left text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Task
                    </th>
                    <SortHeader label="You" k="you_s" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Agent" k="agent_s" sort={sort} onSort={toggleSort} />
                    <SortHeader label="Wall" k="wall_s" sort={sort} onSort={toggleSort} />
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Days
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Prompts
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Edits
                    </th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.project} className="border-t border-line">
                    <tr className="bg-surface">
                      <th scope="rowgroup" colSpan={COLUMNS} className="px-3 py-2 text-left text-sm font-semibold">
                        {g.name}
                        <span className="ml-3 text-xs font-normal tabular-nums text-muted">
                          You {formatWorkTime(g.rows.reduce((n, r) => n + r.you_s, 0))} · Agent{" "}
                          {formatWorkTime(g.rows.reduce((n, r) => n + r.agent_s, 0))}
                        </span>
                      </th>
                    </tr>
                    {g.rows.map((r) => {
                      const id = rowId(r);
                      const isOpen = open.has(id);
                      const detailId = `time-detail-${g.project}-${r.label}`.replace(/[^A-Za-z0-9_-]/g, "_");
                      return (
                        <Fragment key={id}>
                          <tr className="border-t border-line/60 hover:bg-raised">
                            <th scope="row" className="px-3 py-1.5 text-left font-normal">
                              <button
                                type="button"
                                onClick={() => toggleRow(id)}
                                aria-expanded={isOpen}
                                aria-controls={detailId}
                                className="flex w-full items-center gap-2 rounded text-left"
                              >
                                <svg
                                  className={`h-4 w-4 shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  aria-hidden
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                </svg>
                                <span className="break-all font-medium">{r.label}</span>
                                <span className={`status shrink-0 ${KIND_COLOR[r.kind] ?? "text-muted"}`}>{r.kind}</span>
                              </button>
                            </th>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatWorkTime(r.you_s)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatWorkTime(r.agent_s)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{formatWorkTime(r.wall_s)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              <span title={r.days.join(", ")}>
                                {r.days.length}
                                <span className="sr-only"> {r.days.length === 1 ? "day" : "days"}: {r.days.join(", ")}</span>
                              </span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{r.prompts}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{r.edits}</td>
                          </tr>
                          {isOpen && (
                            <tr id={detailId}>
                              <td colSpan={COLUMNS} className="bg-raised px-4 py-3">
                                <div className="sticky left-0 w-[calc(100vw-5.5rem)] max-w-3xl">
                                  <Detail row={r} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="card px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-1 text-2xl font-bold tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

function SortHeader({ label, k, sort, onSort }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void }) {
  const active = sort.key === k;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"} className="px-3 py-2 text-right font-medium">
      <button
        type="button"
        onClick={() => onSort(k)}
        className="inline-flex items-center gap-1 rounded uppercase tracking-wide hover:text-fg"
      >
        {label}
        <span aria-hidden="true" className={active ? "text-link" : "opacity-40"}>
          {active ? (sort.dir === "desc" ? "▼" : "▲") : "↕"}
        </span>
      </button>
    </th>
  );
}

function Detail({ row }: { row: WorklogRow }) {
  const notes = row.notes ?? [];
  const groups = row.task_groups ?? [];
  const hasAny = row.first_prompt || notes.length > 0 || groups.length > 0;
  return (
    <div className="space-y-3 text-sm">
      {row.first_prompt && (
        <div>
          <div className="section-title !mb-1">Started from</div>
          <blockquote className="border-l-2 border-line pl-3 text-muted">“{row.first_prompt}”</blockquote>
        </div>
      )}
      {groups.length > 0 && (
        <div>
          <div className="section-title !mb-1">Task groups</div>
          <ul className="space-y-2">
            {groups.map((g, i) => (
              <li key={`${g.name}-${i}`}>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="break-all">{g.name}</span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {g.done}/{g.total} done
                  </span>
                </div>
                <div
                  className="mt-1 h-2 overflow-hidden rounded-full bg-surface"
                  role="progressbar"
                  aria-label={`${g.name} progress`}
                  aria-valuemin={0}
                  aria-valuemax={g.total}
                  aria-valuenow={g.done}
                  aria-valuetext={`${g.done} of ${g.total} completed`}
                >
                  <div className="h-full bg-ok" style={{ width: `${g.total > 0 ? (g.done / g.total) * 100 : 0}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <div className="section-title !mb-1">Notes and commits</div>
          <ul className="space-y-1">
            {notes.map((n, i) => (
              <li key={`${n.at}-${i}`} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="tabular-nums text-muted">{n.at}</span>
                <span className="status text-muted">{n.type}</span>
                <span className="min-w-0 break-words text-sm">{n.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {row.branches.length > 0 && (
        <p className="text-xs text-muted">
          {row.branches.length === 1 ? "Branch" : "Branches"}: {row.branches.join(", ")}
        </p>
      )}
      {!hasAny && <p className="text-xs text-muted">No extra detail for this task. Details load for the longest tasks only.</p>}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading time report" className="space-y-3">
      <p className="sr-only">Loading…</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="card h-[4.5rem] bg-raised motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="card h-40 bg-raised motion-safe:animate-pulse" />
      <div className="card h-32 bg-raised motion-safe:animate-pulse" />
    </div>
  );
}
