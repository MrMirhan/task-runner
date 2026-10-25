import { resolve } from "node:path";
import type { StoreApi } from "../core/api.ts";
import { openBackend } from "../node/backend.ts";
import { deviceInfo } from "../node/remote.ts";
import { DEFAULT_OPTIONS, taskInfo, type WorklogOptions } from "../worklog/compute.ts";
import { buildReport, formatDuration, renderCsv, renderMarkdown, renderText, resolveRange, summarizeReport, type Range } from "../worklog/report.ts";
import { scanWorklog } from "../worklog/scan.ts";
import { flag, projectFor } from "./commands.ts";

export function worklogOptions(args: string[]): WorklogOptions {
  const minutes = (name: string, fallback: number) => {
    const raw = flag(args, name) ?? process.env[name.slice(2).toUpperCase().replace(/-/g, "_")];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n * 60 : fallback;
  };
  return {
    humanCapSeconds: minutes("--human-cap", DEFAULT_OPTIONS.humanCapSeconds),
    aiCapSeconds: minutes("--ai-cap", DEFAULT_OPTIONS.aiCapSeconds),
  };
}

const exclusions = (args: string[] = []) =>
  (flag(args, "--exclude") ?? process.env.TASK_RUNNER_WORKLOG_EXCLUDE ?? "").split(",").filter(Boolean);

/** Only transcripts touched since the range began can add time to it. */
const daysBackTo = (range: Range) => Math.max(Math.ceil((Date.now() / 1000 - range.from) / 86400) + 1, 2);

export function rangeFromName(name: string, from?: string, to?: string): Range {
  return resolveRange({
    today: name === "today",
    yesterday: name === "yesterday",
    week: name === "week",
    lastWeek: name === "last-week",
    month: name === "month",
    from: name === "custom" ? from : undefined,
    to: name === "custom" ? to : undefined,
  });
}

/** The `worklog` MCP tool: reads this machine's transcripts into the store, then reports from it. */
export async function worklogTool(
  store: StoreApi,
  input: { range: string; from?: string; to?: string; project?: string | null; detail?: boolean },
  deviceId: string,
  options: { scanOnly?: boolean } = {},
) {
  const range = rangeFromName(input.range, input.from, input.to);
  await scanWorklog(store, { sinceDays: daysBackTo(range), options: worklogOptions([]), deviceId });
  if (options.scanOnly) return null;
  return summarizeReport(await buildReport(store, { range, project: input.project, exclude: exclusions(), detail: input.detail, detailLimit: 10 }));
}

export async function worklogCommand(args: string[]): Promise<void> {
  const [first] = args;
  const sub = first && !first.startsWith("--") ? first : "report";
  const backend = openBackend();
  const { store } = backend;
  const deviceId = deviceInfo().id;
  try {
    const options = worklogOptions(args);
    const explicitSince = flag(args, "--since-days");
    const scan = (sinceDays: number | null = args.includes("--all") ? null : Number(explicitSince ?? 120)) =>
      scanWorklog(store, {
        sinceDays,
        options,
        deviceId,
        onFile: process.stderr.isTTY ? () => process.stderr.write(".") : undefined,
      });

    if (sub === "scan") {
      const result = await scan();
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(`Scanned ${result.scanned} transcripts, ${result.skipped} unchanged (${backend.location}).`);
      return;
    }

    if (sub === "pending") {
      if (!args.includes("--no-scan")) await scan();
      const target = flag(args, "--target") ?? "default";
      const rows = await store.worklogPending(target);
      if (rows.length === 0) console.log("Nothing waiting for export.");
      for (const r of rows) {
        console.log(`${r.project_key}\t${taskInfo(r.branch).label}\t${r.branch}\tyou ${formatDuration(r.human_s)}\tagent ${formatDuration(r.ai_s)}\twall ${formatDuration(r.minutes * 60)}`);
      }
      return;
    }

    if (sub === "exported") {
      const [, project, branch] = args;
      if (!project || !branch) throw new Error("Usage: task-runner-mcp worklog exported <project> <branch> [--target name]");
      console.log(JSON.stringify(await store.worklogMarkExported(project, branch, flag(args, "--target") ?? "default")));
      return;
    }

    if (sub !== "report") throw new Error("Usage: task-runner-mcp worklog [report|scan|pending|exported] [options]");

    const range = resolveRange({
      today: args.includes("--today"),
      yesterday: args.includes("--yesterday"),
      week: args.includes("--week"),
      lastWeek: args.includes("--last-week"),
      month: args.includes("--month"),
      days: flag(args, "--days") ? Number(flag(args, "--days")) : undefined,
      from: flag(args, "--from"),
      to: flag(args, "--to"),
    });

    if (!args.includes("--no-scan")) {
      await scan(args.includes("--all") ? null : Number(explicitSince ?? daysBackTo(range)));
      if (process.stderr.isTTY) process.stderr.write("\n");
    }

    let project = flag(args, "--project") ?? null;
    if (project === ".") project = (await projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd()))).project;

    const exclude = exclusions(args);
    const format = flag(args, "--format") ?? "text";
    if (format === "csv") {
      console.log(await renderCsv(store, { range, project, exclude }));
      return;
    }
    const detail = args.includes("--detail") || format === "md" || format === "json";
    const report = await buildReport(store, { range, project, exclude, detail });
    if (format === "json") console.log(JSON.stringify(report));
    else if (format === "md") console.log(renderMarkdown(report));
    else if (format === "text") console.log(renderText(report, { detail }));
    else throw new Error(`Unknown format '${format}'. Use text, md, csv or json.`);
  } finally {
    backend.close();
  }
}

/** Feeds the panel's Session tab: reads only this session's transcript, then what memory gained since it began. */
export async function sessionCommand(args: string[]): Promise<void> {
  const id = flag(args, "--id");
  if (!id) throw new Error("Usage: task-runner-mcp session --id <session id> [--cwd dir]");
  const backend = openBackend();
  try {
    const { store } = backend;
    const detected = await projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd()));
    await scanWorklog(store, { sinceDays: null, session: id, options: worklogOptions(args), deviceId: deviceInfo().id });
    const time = await store.worklogSession(id);
    const since = time.started_at ?? Math.floor(Date.now() / 1000) - 60;
    const changed = await store.changedSince({ project: detected.project, since });
    process.stdout.write(`${JSON.stringify({ project: detected.project, branch: detected.branch, location: backend.location, ...time, ...changed })}\n`);
  } finally {
    backend.close();
  }
}
