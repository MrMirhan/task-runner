import { StoreError } from "./errors.ts";
import type { ApiRequest, ApiResponse } from "./http.ts";
import { RulesStore, type RuleKey } from "./rules.ts";

type Body = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const need = (value: string | null | undefined, name: string): string => {
  if (!value) throw new StoreError("invalid", `${name} is required`);
  return value;
};

const keyOf = (b: Body): RuleKey => ({
  scope: need(text(b.scope), "scope") as RuleKey["scope"],
  ref: text(b.ref) ?? null,
  device: text(b.device) ?? null,
});

export function isRulesPath(path: string): boolean {
  return path.startsWith("/rules") || path.startsWith("/devices");
}

/**
 * JSON API for rules and devices. The local dashboard and the Cloudflare Worker serve it the same way.
 *
 *   GET    /rules/resolve?project&org&device   -> { text, chars, parts, truncated, pending }
 *   GET    /rules/docs                         -> { docs }
 *   PUT    /rules/docs                         { scope, ref?, device?, body }  (a person writes; empty body removes)
 *   DELETE /rules/docs?id
 *   GET    /rules/revisions?doc_id
 *   GET    /rules/proposals?status=pending|approved|rejected|all
 *   POST   /rules/proposals                    { scope, ref?, device?, mode?, text, reason?, author? }
 *   POST   /rules/proposals/approve            { id, text? }
 *   POST   /rules/proposals/reject             { id }
 *   GET    /devices
 *   POST   /devices                            { id, label, platform? }   (register or touch)
 *   PUT    /devices                            { id, label }              (rename)
 */
export function handleRulesApi(rules: RulesStore, req: ApiRequest): ApiResponse {
  try {
    return { status: 200, body: route(rules, req) };
  } catch (error) {
    if (error instanceof StoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return { status, body: { error: error.message } };
    }
    return { status: 500, body: { error: error instanceof Error ? error.message : "Internal error" } };
  }
}

function route(rules: RulesStore, { method, path, query, body }: ApiRequest): unknown {
  const b = (body ?? {}) as Body;
  switch (`${method} ${path}`) {
    case "GET /rules/resolve":
      return {
        success: true,
        ...rules.resolve({ project: query.get("project"), org: query.get("org"), device: query.get("device") }),
        pending: rules.pendingCount(),
      };
    case "GET /rules/docs":
      return { success: true, docs: rules.listDocs() };
    case "PUT /rules/docs":
      return { success: true, ...rules.setDoc(keyOf(b), typeof b.body === "string" ? b.body : "", "user") };
    case "DELETE /rules/docs":
      return { success: true, ...rules.deleteDoc(need(query.get("id"), "id")) };
    case "GET /rules/revisions":
      return { success: true, revisions: rules.revisions(need(query.get("doc_id"), "doc_id")) };
    case "GET /rules/proposals": {
      const status = (query.get("status") ?? "pending") as "pending" | "approved" | "rejected" | "all";
      return { success: true, proposals: rules.listProposals(status) };
    }
    case "POST /rules/proposals":
      return {
        success: true,
        proposal: rules.propose({
          key: keyOf(b), mode: text(b.mode), text: need(text(b.text), "text"),
          reason: text(b.reason) ?? null, author: text(b.author) ?? "agent",
        }),
      };
    case "POST /rules/proposals/approve":
      return { success: true, ...rules.approve(need(text(b.id), "id"), text(b.text)) };
    case "POST /rules/proposals/reject":
      return { success: true, ...rules.reject(need(text(b.id), "id")) };
    case "GET /devices":
      return { success: true, devices: rules.listDevices() };
    case "POST /devices":
      return {
        success: true,
        device: rules.registerDevice({ id: need(text(b.id), "id"), label: need(text(b.label), "label"), platform: text(b.platform) ?? null }),
      };
    case "PUT /devices":
      return { success: true, ...rules.renameDevice(need(text(b.id), "id"), need(text(b.label), "label")) };
    default:
      throw new StoreError("not_found", `No such endpoint: ${method} ${path}`);
  }
}
