import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreApi } from "../core/api.ts";
import { RulesStore } from "../core/rules.ts";
import type { Store } from "../core/store.ts";
import { flag, openStore } from "./commands.ts";
import { buildReport, renderCsv, resolveRange } from "../worklog/report.ts";
import { scanWorklog } from "../worklog/scan.ts";
import { handleApi } from "./rest.ts";
import { worklogOptions } from "./worklog.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown) =>
  send(res, status, JSON.stringify(body), "application/json");

/**
 * GET /api/worklog?range=today|yesterday|week|last-week|month|custom&from&to&project&detail=true
 * GET /api/worklog.csv with the same query. Reads the session transcripts first (incremental).
 */
async function worklogApi(store: Store, url: URL): Promise<{ status: number; body: string; type: string }> {
  const q = url.searchParams;
  const range = q.get("range") ?? "week";
  try {
    const resolved = resolveRange({
      today: range === "today",
      yesterday: range === "yesterday",
      week: range === "week",
      lastWeek: range === "last-week",
      month: range === "month",
      from: range === "custom" ? (q.get("from") ?? undefined) : undefined,
      to: range === "custom" ? (q.get("to") ?? undefined) : undefined,
    });
    const daysBack = Math.ceil((Date.now() / 1000 - resolved.from) / 86400) + 1;
    await scanWorklog(store, { sinceDays: Math.max(daysBack, 2), options: worklogOptions([]) });
    const project = q.get("project") || null;
    const exclude = (process.env.TASK_RUNNER_WORKLOG_EXCLUDE ?? "").split(",").filter(Boolean);
    if (url.pathname.endsWith(".csv")) {
      return { status: 200, body: renderCsv(store, { range: resolved, project, exclude }), type: "text/csv; charset=utf-8" };
    }
    const report = buildReport(store, { range: resolved, project, exclude, detail: q.get("detail") === "true" });
    return { status: 200, body: JSON.stringify({ success: true, ...report }), type: "application/json" };
  } catch (error) {
    return { status: 400, body: JSON.stringify({ error: error instanceof Error ? error.message : "Bad request" }), type: "application/json" };
  }
}

export function findStaticDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "dashboard"), join(here, "..", "..", "dist", "dashboard")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function createDashboardServer(store: Store, staticDir: string | null, rules?: RulesStore): Server {
  return createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (!LOCAL_HOST.test(host)) return sendJson(res, 403, { error: "Forbidden host" });

      const url = new URL(req.url ?? "/", `http://${host}`);
      const method = req.method ?? "GET";

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return sendJson(res, 403, { error: "Cross-origin request refused" });

        let body: unknown;
        if (method === "POST" || method === "PUT") {
          if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
            return sendJson(res, 415, { error: "Content-Type must be application/json" });
          }
          const raw = await readBody(req);
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            return sendJson(res, 400, { error: "Invalid JSON" });
          }
        }
        if (method === "GET" && (url.pathname === "/api/worklog" || url.pathname === "/api/worklog.csv")) {
          const out = await worklogApi(store, url);
          return send(res, out.status, out.body, out.type);
        }
        const out = await handleApi(store, {
          method: method === "HEAD" ? "GET" : method,
          path: url.pathname.slice("/api".length) || "/",
          query: url.searchParams,
          body,
        }, rules);
        return sendJson(res, out.status, out.body);
      }

      if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      if (!staticDir) {
        return send(
          res,
          200,
          "<!doctype html><title>Task Runner</title><p>The dashboard files are not part of this install. The JSON API is at /api.</p>",
          TYPES[".html"],
        );
      }

      const root = resolve(staticDir);
      let file = normalize(join(root, decodeURIComponent(url.pathname)));
      if (file !== root && !file.startsWith(root + sep)) return sendJson(res, 403, { error: "Forbidden" });
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) {
        if (extname(file)) return sendJson(res, 404, { error: "Not found" });
        file = join(root, "index.html");
      }
      return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
    } catch (error) {
      return sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}

export async function dashboard(args: string[]): Promise<void> {
  const port = Number(flag(args, "--port") ?? process.env.PORT ?? 4747);
  const { store, db } = openStore();
  const server = createDashboardServer(store, findStaticDir(), new RulesStore(db));

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? `Port ${port} is in use. Try --port <other>.` : error.message);
    db.close();
    process.exit(1);
  });

  await new Promise<void>((ready) => server.listen(port, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${port}`;
  console.error(`Task Runner dashboard on ${url} (Ctrl+C to stop)`);

  if (args.includes("--open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execFile(opener, [url], () => undefined);
  }

  const stop = () => {
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
