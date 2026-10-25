import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SERVER_VERSION } from "../core/constants.ts";
import { handleApi } from "../core/rest.ts";
import { RULE_SCOPES, type RulesStore, type RuleScope } from "../core/rules.ts";
import { handleRpc, type RpcCall } from "../core/rpc.ts";
import type { Store } from "../core/store.ts";
import { createServer } from "../mcp/server.ts";
import { SessionHolder, type Session } from "../mcp/session.ts";
import { buildReport, renderCsv, resolveRange, summarizeReport } from "../worklog/report.ts";

/**
 * The Task Runner server as one web-standard handler: the MCP endpoint, the RPC endpoint the
 * local CLI uses when signed in, and the JSON API behind the web page. The Worker and the
 * tests run exactly this.
 */
export interface AppDeps {
  store: Store;
  rules: RulesStore;
  /** The one key that unlocks everything except /api/health. */
  key: string;
  /** Workers cannot compile JSON Schema validators at runtime; they pass a non-codegen one. */
  mcpOptions?: Omit<ServerOptions, "instructions">;
}

const MAX_BODY = 1024 * 1024;
const CONTEXT_SETTING = "mcp_context";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });
}

export async function sameKey(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  // Hash both so the comparison always runs over equal lengths in constant time.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Paths this handler answers. Everything else is the web page. */
export const isAppPath = (path: string) => path === "/mcp" || path === "/api" || path.startsWith("/api/");

export const health = () =>
  json({ ok: true, version: SERVER_VERSION, mode: "server", auth: "bearer", features: ["mcp", "memory", "tasks", "graph", "worklog", "rules"] });

export const bearerOf = (request: Request) => /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]?.trim() ?? "";

/** Health, the key check, then the routes. */
export async function handleApp(deps: AppDeps, request: Request): Promise<Response> {
  if (new URL(request.url).pathname === "/api/health") return health();
  if (!deps.key || deps.key.length < 24) {
    return json({ error: "Server key missing or shorter than 24 characters. Set it with: wrangler secret put TASK_RUNNER_KEY" }, 500);
  }
  if (!(await sameKey(bearerOf(request), deps.key))) return json({ error: "Unauthorized" }, 401);
  return routeApp(deps, request);
}

/** The routes, for a caller that already checked the key. */
export async function routeApp(deps: Omit<AppDeps, "key">, request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return json({ error: "Request too large" }, 413);
  if (url.pathname === "/mcp") return mcp(deps, request);

  let body: unknown;
  if (request.method === "POST" || request.method === "PUT") {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: "Request too large" }, 413);
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
  }

  const path = url.pathname.replace(/^\/api/, "") || "/";
  if (request.method === "POST" && path === "/rpc") {
    const out = handleRpc(deps.store, deps.rules, body as RpcCall);
    return json(out.body, out.status);
  }
  if (request.method === "GET" && (path === "/worklog" || path === "/worklog.csv")) return worklog(deps.store, url, path);

  const out = await handleApi(deps.store, { method: request.method === "HEAD" ? "GET" : request.method, path, query: url.searchParams, body }, deps.rules);
  return json(out.body, out.status);
}

/** Reports from the time rows the signed-in devices uploaded. The server never reads transcripts. */
async function worklog(store: Store, url: URL, path: string): Promise<Response> {
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
    const project = q.get("project") || null;
    const exclude = (q.get("exclude") ?? "").split(",").filter(Boolean);
    if (path.endsWith(".csv")) {
      return new Response(await renderCsv(store, { range: resolved, project, exclude }), {
        headers: { "Content-Type": "text/csv; charset=utf-8", ...SECURITY_HEADERS },
      });
    }
    return json({ success: true, ...(await buildReport(store, { range: resolved, project, exclude, detail: q.get("detail") === "true" })) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
  }
}

/**
 * Stateless MCP: a fresh server per request. The scope comes from X-Task-Runner-* headers when the
 * client sends them, otherwise from the last set_context, which is kept in the database.
 */
async function mcp(deps: Omit<AppDeps, "key">, request: Request): Promise<Response> {
  const { store, rules } = deps;
  const header = (name: string) => request.headers.get(`X-Task-Runner-${name}`)?.trim() || null;
  const device = header("Device");

  const session = new SessionHolder(
    async () => {
      const project = header("Project");
      if (project) {
        const s: Session = { project, project_path: header("Path"), branch: header("Branch"), pr: null, org: header("Org") };
        store.setContext({ project: s.project, project_path: s.project_path });
        return s;
      }
      const saved = store.worklogSetting(CONTEXT_SETTING);
      return saved ? (JSON.parse(saved) as Session) : null;
    },
    (s) => store.setWorklogSetting(CONTEXT_SETTING, JSON.stringify(s)),
  );

  const server = createServer(
    {
      store,
      session,
      rules: {
        async show() {
          const s = await session.get();
          const resolved = rules.resolve({ project: s.project, org: s.org ?? null, device });
          return { text: resolved.text, parts: resolved.parts, pending: rules.pendingCount(), stale: false };
        },
        async propose(input) {
          const s = await session.get();
          const scope = input.scope as RuleScope;
          if (!(RULE_SCOPES as readonly string[]).includes(scope)) throw new Error(`Unknown scope '${scope}'`);
          const made = rules.propose({
            key: {
              scope,
              ref: scope === "org" ? (input.ref ?? s.org) : scope === "project" || scope === "project_device" ? (input.ref ?? s.project) : null,
              device: scope === "device" || scope === "project_device" ? device : null,
            },
            mode: input.mode as "append" | "replace" | undefined,
            text: input.text,
            reason: input.reason,
            author: "agent",
          });
          return { id: made.id, scope: made.scope };
        },
      },
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
        return summarizeReport(await buildReport(store, { range, project: input.project, detail: input.detail, detailLimit: 10 }));
      },
    },
    deps.mcpOptions,
  );

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    void server.close();
  }
}
