import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { StoreApi } from "../core/api.ts";
import { flag, openStore } from "./commands.ts";
import { handleApi } from "./rest.ts";

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

export function findStaticDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "dashboard"), join(here, "..", "..", "dist", "dashboard")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

export function createDashboardServer(store: StoreApi, staticDir: string | null): Server {
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
        const out = await handleApi(store, {
          method: method === "HEAD" ? "GET" : method,
          path: url.pathname.slice("/api".length) || "/",
          query: url.searchParams,
          body,
        });
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
  const server = createDashboardServer(store, findStaticDir());

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
