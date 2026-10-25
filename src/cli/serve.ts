import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.ts";
import { SessionHolder } from "../mcp/session.ts";
import { formatDuration, buildReport, resolveRange } from "../worklog/report.ts";
import { scanWorklog } from "../worklog/scan.ts";
import { deviceInfo, openRulesClient, resolveForHook } from "../node/remote.ts";
import { openStore, projectFor } from "./commands.ts";
import { worklogOptions } from "./worklog.ts";

export async function serve(): Promise<void> {
  const { store, db } = openStore();
  const cwd = process.env.TASK_RUNNER_CWD || process.cwd();

  const session = new SessionHolder(() => {
    const detected = projectFor(store, cwd);
    return { project: detected.project, project_path: detected.project_path, branch: detected.branch, pr: null, org: detected.org };
  });

  const device = deviceInfo();
  const rulesClient = openRulesClient(db);
  void rulesClient.registerDevice(device).catch(() => undefined);

  const server = createServer({
    store,
    session,
    rules: {
      async show() {
        const s = session.get();
        const resolved = await rulesClient.resolve({ project: s.project, org: s.org, device: device.id }).catch(async (error) => {
          const fallback = await resolveForHook(rulesClient, { project: s.project, org: s.org, device: device.id });
          if (!fallback.text) throw error;
          return { text: fallback.text, parts: [], pending: 0, chars: fallback.text.length, truncated: false, stale: true };
        });
        return { text: resolved.text, parts: resolved.parts, pending: resolved.pending, stale: "stale" in resolved };
      },
      async propose(input) {
        const s = session.get();
        const scope = input.scope as "global" | "device" | "org" | "project" | "project_device";
        const made = await rulesClient.propose({
          key: {
            scope,
            ref: scope === "org" ? (input.ref ?? s.org) : scope === "project" || scope === "project_device" ? (input.ref ?? s.project) : null,
            device: scope === "device" || scope === "project_device" ? device.id : null,
          },
          mode: input.mode,
          text: input.text,
          reason: input.reason,
          author: "agent",
        });
        return { id: made.id, scope: made.scope };
      },
    },
    fileExists: (root, relative) => existsSync(resolve(root, relative)),
    worklog: async (input) => {
      const range = resolveRange({
        today: input.range === "today",
        yesterday: input.range === "yesterday",
        week: input.range === "week",
        lastWeek: input.range === "last-week",
        month: input.range === "month",
        from: input.range === "custom" ? input.from : undefined,
        to: input.range === "custom" ? input.to : undefined,
      });
      const daysBack = Math.ceil((Date.now() / 1000 - range.from) / 86400) + 1;
      await scanWorklog(store, { sinceDays: Math.max(daysBack, 2), options: worklogOptions([]) });
      const exclude = (process.env.TASK_RUNNER_WORKLOG_EXCLUDE ?? "").split(",").filter(Boolean);
      const report = buildReport(store, { range, project: input.project, exclude, detail: input.detail, detailLimit: 10 });
      return {
        period: range.label,
        totals: {
          you: formatDuration(report.totals.you_s),
          agent: formatDuration(report.totals.agent_s),
          wall: formatDuration(report.totals.wall_s),
          tasks: report.totals.tasks,
          projects: report.totals.projects,
        },
        by_day: report.days.map((d) => ({ day: d.day, you: formatDuration(d.you_s), agent: formatDuration(d.agent_s), wall: formatDuration(d.wall_s) })),
        tasks: report.rows.slice(0, 20).map((r) => ({
          project: r.project,
          task: r.label,
          kind: r.kind,
          you: formatDuration(r.you_s),
          agent: formatDuration(r.agent_s),
          wall: formatDuration(r.wall_s),
          days: r.days,
          prompts: r.prompts,
          file_edits: r.edits,
          started_from: r.first_prompt ?? undefined,
          task_groups: r.task_groups?.map((g) => `${g.name} ${g.done}/${g.total}`),
          notes: r.notes?.slice(0, 6).map((n) => `${n.at} [${n.type}] ${n.title}`),
        })),
        more_tasks: Math.max(0, report.rows.length - 20) || undefined,
      };
    },
  });

  // Warm the time cache a little after start so the first question about time is fast. The stamp keeps
  // several sessions that start together from all scanning the same files.
  setTimeout(() => {
    const now = Math.floor(Date.now() / 1000);
    if (now - Number(store.worklogSetting("worklog_warmed_at") ?? 0) < 600) return;
    store.setWorklogSetting("worklog_warmed_at", String(now));
    void scanWorklog(store, { sinceDays: 8, options: worklogOptions([]) }).catch(() => undefined);
  }, 20_000).unref();

  const close = () => {
    try {
      db.close();
    } catch {
      // already closed
    }
  };
  process.on("exit", close);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
