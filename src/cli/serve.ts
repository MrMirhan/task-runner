import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../mcp/server.ts";
import { SessionHolder } from "../mcp/session.ts";
import { openBackend } from "../node/backend.ts";
import { deviceInfo, resolveForHook } from "../node/remote.ts";
import { worklogTool } from "./worklog.ts";
import { projectFor } from "./commands.ts";

/**
 * The stdio server. Memory lives where the backend says: this machine, or the server this machine
 * signed in to. The tools are the same either way.
 */
export async function serve(): Promise<void> {
  const backend = openBackend();
  const { store } = backend;
  const cwd = process.env.TASK_RUNNER_CWD || process.cwd();

  const session = new SessionHolder(async () => {
    const detected = await projectFor(store, cwd);
    return { project: detected.project, project_path: detected.project_path, branch: detected.branch, pr: null, org: detected.org };
  });

  const device = deviceInfo();
  void backend.rules.registerDevice(device).catch(() => undefined);

  const server = createServer({
    store,
    session,
    rules: {
      async show() {
        const s = await session.get();
        const ctx = { project: s.project, org: s.org, device: device.id };
        try {
          const resolved = await backend.rules.resolve(ctx);
          return { text: resolved.text, parts: resolved.parts, pending: resolved.pending, stale: false };
        } catch (error) {
          const fallback = await resolveForHook(backend.rules, ctx);
          if (!fallback.text) throw error;
          return { text: fallback.text, parts: [], pending: 0, stale: true };
        }
      },
      async propose(input) {
        const s = await session.get();
        const scope = input.scope as "global" | "device" | "org" | "project" | "project_device";
        const made = await backend.rules.propose({
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
    worklog: (input) => worklogTool(store, input, device.id),
  });

  // Warm the time cache a little after start so the first question about time is fast. The stamp keeps
  // several sessions that start together from all scanning the same files.
  setTimeout(() => {
    void (async () => {
      const now = Math.floor(Date.now() / 1000);
      const stampKey = `worklog_warmed_at:${device.id}`;
      if (now - Number((await store.worklogSetting(stampKey)) ?? 0) < 600) return;
      await store.setWorklogSetting(stampKey, String(now));
      await worklogTool(store, { range: "week" }, device.id, { scanOnly: true });
    })().catch(() => undefined);
  }, 20_000).unref();

  const close = () => {
    try {
      backend.close();
    } catch {
      // already closed
    }
  };
  process.on("exit", close);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  await server.connect(new StdioServerTransport());
}
