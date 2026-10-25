import { resolve } from "node:path";
import { DEFAULT_OPTIONS, taskInfo, type WorklogOptions } from "../worklog/compute.ts";
import { buildReport, formatDuration, renderCsv, renderMarkdown, renderText, resolveRange } from "../worklog/report.ts";
import { scanWorklog } from "../worklog/scan.ts";
import { flag, openStore, projectFor } from "./commands.ts";

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

export async function worklogCommand(args: string[]): Promise<void> {
  const [first] = args;
  const sub = first && !first.startsWith("--") ? first : "report";
  const { store, db } = openStore();
  try {
    const options = worklogOptions(args);
    const explicitSince = flag(args, "--since-days");
    const scan = (sinceDays: number | null = args.includes("--all") ? null : Number(explicitSince ?? 120)) =>
      scanWorklog(store, {
        sinceDays,
        options,
        onFile: process.stderr.isTTY ? () => process.stderr.write(".") : undefined,
      });

    if (sub === "scan") {
      const result = await scan();
      console.log(`Scanned ${result.scanned} transcripts, ${result.skipped} unchanged.`);
      return;
    }

    if (sub === "pending") {
      if (!args.includes("--no-scan")) await scan();
      const target = flag(args, "--target") ?? "default";
      const rows = store.worklogPending(target);
      if (rows.length === 0) console.log("Nothing waiting for export.");
      for (const r of rows) {
        console.log(`${r.project_key}\t${taskInfo(r.branch).label}\t${r.branch}\tyou ${formatDuration(r.human_s)}\tagent ${formatDuration(r.ai_s)}\twall ${formatDuration(r.minutes * 60)}`);
      }
      return;
    }

    if (sub === "exported") {
      const [, project, branch] = args;
      if (!project || !branch) throw new Error("Usage: task-runner-mcp worklog exported <project> <branch> [--target name]");
      console.log(JSON.stringify(store.worklogMarkExported(project, branch, flag(args, "--target") ?? "default")));
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

    // Only transcripts touched since the range began can add time to it.
    if (!args.includes("--no-scan")) {
      const daysBack = Math.ceil((Date.now() / 1000 - range.from) / 86400) + 1;
      await scan(args.includes("--all") ? null : Number(explicitSince ?? Math.max(daysBack, 2)));
      if (process.stderr.isTTY) process.stderr.write("\n");
    }

    let project = flag(args, "--project") ?? null;
    if (project === ".") project = projectFor(store, resolve(flag(args, "--cwd") ?? process.cwd())).project;

    const exclude = (flag(args, "--exclude") ?? process.env.TASK_RUNNER_WORKLOG_EXCLUDE ?? "").split(",").filter(Boolean);
    const format = flag(args, "--format") ?? "text";
    if (format === "csv") {
      console.log(renderCsv(store, { range, project, exclude }));
      return;
    }
    const detail = args.includes("--detail") || format === "md" || format === "json";
    const report = buildReport(store, { range, project, exclude, detail });
    if (format === "json") console.log(JSON.stringify(report));
    else if (format === "md") console.log(renderMarkdown(report));
    else if (format === "text") console.log(renderText(report, { detail }));
    else throw new Error(`Unknown format '${format}'. Use text, md, csv or json.`);
  } finally {
    db.close();
  }
}
