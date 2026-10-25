import { StoreError } from "../core/errors.ts";
import type { StoreApi } from "../core/api.ts";
import { SERVER_VERSION } from "../core/constants.ts";
import type { ApiRequest, ApiResponse } from "../core/http.ts";
import { handleRulesApi, isRulesPath } from "../core/rules-api.ts";
import type { RulesStore } from "../core/rules.ts";

export type { ApiRequest, ApiResponse } from "../core/http.ts";

type Body = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const need = (value: string | null | undefined, name: string): string => {
  if (!value) throw new StoreError("invalid", `${name} is required`);
  return value;
};

/**
 * JSON API behind the local dashboard. Response shapes follow the dashboard's types
 * (`success: true` plus the payload); errors are `{ error }` with 400, 404 or 409.
 *
 *   GET    /health
 *   GET    /projects                          -> { projects: [{ key, project_path, project_name, ... }] }
 *   GET    /context?project&all=true&limit    -> { entries }
 *   POST   /memory                            { project_key, type, title, content, scope?, scope_ref?, tags? }
 *   PUT    /memory                            { id, title?, content?, type?, tags? }
 *   DELETE /memory?id
 *   GET    /search?q&project&limit            -> { entries }
 *   GET    /graph/all?project_key             -> { entities, relations, entity_count, relation_count }
 *   GET    /graph/stats?project_key           -> stats with entity_types: [{ entity_type, cnt }]
 *   GET    /entities?id | ?project_key&name   -> { entity, observations, relations: { outgoing, incoming } }
 *   POST   /entities/forget                   { project_key, name, entity_type? }
 *   DELETE /relations?id
 *   GET    /recall?q&project_key&limit
 *   GET    /tasks/groups?project_key          -> { groups }
 *   GET    /tasks/status?project_key&task_group -> { tasks }
 *   GET    /tasks/result?project_key&task_id&task_group -> { result, error, status, title }
 *   DELETE /tasks?project_key&task_group
 *   GET    /export?project
 */
export async function handleApi(store: StoreApi, req: ApiRequest, rules?: RulesStore): Promise<ApiResponse> {
  if (rules && isRulesPath(req.path)) return handleRulesApi(rules, req);
  try {
    return { status: 200, body: await route(store, req) };
  } catch (error) {
    if (error instanceof StoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return { status, body: { error: error.message } };
    }
    return { status: 500, body: { error: error instanceof Error ? error.message : "Internal error" } };
  }
}

async function route(store: StoreApi, { method, path, query, body }: ApiRequest): Promise<unknown> {
  const b = (body ?? {}) as Body;
  const key = `${method} ${path}`;

  switch (key) {
    case "GET /health":
      return {
        ok: true,
        version: SERVER_VERSION,
        mode: "local",
        auth: "none",
        features: ["memory", "tasks", "graph", "worklog", "rules"],
      };

    case "GET /projects": {
      const projects = await store.listProjects();
      return { success: true, projects };
    }

    case "GET /context": {
      const limit = query.get("limit");
      const out = await store.getContext({
        project: need(query.get("project"), "project"),
        branch: query.get("branch"),
        pr: query.get("pr"),
        all: query.get("all") === "true",
        limit: limit ? Number(limit) : 100,
        type: text(query.get("type")),
      });
      return { success: true, ...out };
    }

    case "POST /memory": {
      const saved = await store.saveEntry({
        project: need(text(b.project_key), "project_key"),
        type: need(text(b.type), "type"),
        title: need(text(b.title), "title"),
        content: need(text(b.content), "content"),
        scope: text(b.scope),
        scope_ref: text(b.scope_ref) ?? null,
        tags: text(b.tags) ?? null,
      });
      return { success: true, ...saved };
    }

    case "PUT /memory":
      return {
        success: true,
        ...(await store.updateEntry({
          id: need(text(b.id), "id"),
          title: text(b.title),
          content: text(b.content),
          type: text(b.type),
          tags: typeof b.tags === "string" ? b.tags : undefined,
        })),
      };

    case "DELETE /memory":
      return { success: true, ...(await store.deleteEntry(need(query.get("id"), "id"))) };

    case "GET /search": {
      const limit = query.get("limit");
      const out = await store.searchEntries({
        q: need(query.get("q"), "q"),
        project: query.get("project"),
        limit: limit ? Number(limit) : undefined,
      });
      return { success: true, ...out };
    }

    case "GET /graph/all":
      return { success: true, ...(await store.graphAll(need(query.get("project_key"), "project_key"))) };

    case "GET /graph/stats": {
      const stats = await store.graphStats(need(query.get("project_key"), "project_key"));
      return {
        success: true,
        ...stats,
        entity_types: stats.entity_types.map((t) => ({ entity_type: t.entity_type, cnt: t.count })),
      };
    }

    case "GET /entities": {
      const id = query.get("id");
      let project = query.get("project_key");
      let name = query.get("name");
      let type = query.get("entity_type") ?? undefined;
      if (id) {
        const found = await store.findEntityById(id);
        if (!found) throw new StoreError("not_found", "Entity not found");
        project = found.project_key;
        name = found.name;
        type = found.entity_type;
      }
      const detail = await store.getEntity({
        project: need(project, "project_key"),
        name: need(name, "name"),
        entity_type: type,
      });
      return { success: true, ...detail };
    }

    case "POST /entities/forget":
      return {
        success: true,
        ...(await store.forget({
          project: need(text(b.project_key), "project_key"),
          name: need(text(b.name), "name"),
          entity_type: text(b.entity_type),
        })),
      };

    case "DELETE /relations":
      return { success: true, ...(await store.deleteRelation(need(query.get("id"), "id"))) };

    case "GET /recall": {
      const limit = query.get("limit");
      const out = await store.recall({
        project: need(query.get("project_key"), "project_key"),
        q: need(query.get("q"), "q"),
        entity_type: text(query.get("entity_type")),
        limit: limit ? Number(limit) : undefined,
      });
      return { success: true, ...out };
    }

    case "GET /tasks/groups":
      return { success: true, groups: await store.listTaskGroups(need(query.get("project_key"), "project_key")) };

    case "GET /tasks/status": {
      const project = need(query.get("project_key"), "project_key");
      const out = (await store.taskStatus({ project, task_group: query.get("task_group") })) as { tasks: unknown[] };
      return { success: true, tasks: out.tasks };
    }

    case "GET /tasks/result": {
      const out = await store.taskResult({
        project: need(query.get("project_key"), "project_key"),
        task_id: need(query.get("task_id"), "task_id"),
        task_group: query.get("task_group"),
      });
      return { success: true, ...out };
    }

    case "DELETE /tasks":
      return {
        success: true,
        ...(await store.clearTasks({
          project: need(query.get("project_key"), "project_key"),
          task_group: query.get("task_group"),
        })),
      };

    case "GET /export":
      return await store.exportAll(query.get("project"));

    default:
      throw new StoreError("not_found", `No such endpoint: ${method} ${path}`);
  }
}
