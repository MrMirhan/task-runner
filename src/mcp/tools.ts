import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { StoreApi } from "../core/api.ts";
import {
  ENTITY_TYPES,
  ENTRY_TYPES,
  GLOBAL_PROJECT,
  RELATION_TYPES,
  SCOPES,
} from "../core/constants.ts";
import { StoreError } from "../core/errors.ts";
import { parseTaskMarkdown, slugify } from "../core/parser.ts";
import type { Session, SessionHolder } from "./session.ts";

export interface ToolContext {
  store: StoreApi;
  session: SessionHolder;
  /** Local mode only: lets graph_stats flag `file` entities whose path no longer exists. */
  fileExists?: (projectPath: string, relativePath: string) => boolean;
  /** Reads and proposes the user's rules (local database or the server). */
  rules?: {
    show(): Promise<{ text: string; parts: Array<{ label: string; chars: number }>; pending: number; stale: boolean; error?: string }>;
    propose(input: { scope: string; text: string; mode?: string; reason?: string; ref?: string }): Promise<{ id: string; scope: string }>;
  };
  /** Local mode only: reads the agent transcripts on disk and returns time per project and task. */
  worklog?: (input: {
    range: string;
    from?: string;
    to?: string;
    project?: string | null;
    detail?: boolean;
  }) => Promise<unknown>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
});

async function run(fn: () => unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof StoreError) return fail(error.message);
    return fail(`Internal error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type Row = Record<string, unknown>;

const day = (seconds: unknown): string | undefined =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString().slice(0, 10) : undefined;

const clip = (text: unknown, max: number): string => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Facts carry their date so a reader can judge how stale they are. */
const fact = (f: Row) => ({ id: f.id, text: f.content, at: day(f.created_at) });

function shapeEntity(e: Row, session: Session) {
  return {
    name: e.name,
    type: e.entity_type,
    ...(e.project_key !== session.project ? { project: e.project_key } : {}),
    summary: e.summary ?? undefined,
    importance: typeof e.importance === "number" ? Number(e.importance.toFixed(2)) : undefined,
    score: e.score,
    facts: Array.isArray(e.observations) ? (e.observations as Row[]).map(fact) : undefined,
  };
}

const looksLikePath = (name: string) => !/\s/.test(name) && (/[\\/]/.test(name) || /\.\w{1,6}$/.test(name));

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const entityType = z.enum(ENTITY_TYPES);

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { store, session } = ctx;

  // ─── Context ──────────────────────────────────────────

  server.registerTool(
    "set_context",
    {
      title: "Set project context",
      description:
        "Override the auto-detected project, branch or PR for this session. Optional: the project is detected from the working directory, so call it only to correct the scope.",
      inputSchema: {
        project: z.string().optional().describe("Project key; omit to keep the detected one"),
        project_path: z.string().optional().describe("Absolute project path"),
        project_name: z.string().optional().describe("Human-readable name"),
        branch: z.string().optional(),
        pr: z.string().optional().describe("PR number"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ project, project_path, project_name, branch, pr }) =>
      run(async () => {
        const detected = await session.detected();
        let next: Session;
        if (project) {
          const sameAsDetected = detected?.project === project;
          next = {
            project,
            project_path: project_path ?? (sameAsDetected ? detected?.project_path : null) ?? null,
            branch: branch ?? (sameAsDetected ? detected?.branch : null) ?? null,
            pr: pr ?? null,
            org: detected?.org ?? null,
          };
        } else if (detected) {
          next = { ...detected, branch: branch ?? detected.branch, pr: pr ?? null };
        } else {
          throw new StoreError("invalid", "project is required: no project could be detected");
        }

        const stored = await store.setContext({ project: next.project, project_path: next.project_path, project_name });
        await session.set(next);
        return {
          project: next.project,
          branch: next.branch ?? undefined,
          pr: next.pr ?? undefined,
          created: stored.created,
          ...(stored.same_path_projects.length
            ? { warning: `Other projects share this path: ${stored.same_path_projects.join(", ")}. Reuse one key to keep memory in one place.` }
            : {}),
        };
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Projects that have memory, newest first. Rarely needed: the current project is detected.",
      inputSchema: {
        query: z.string().optional().describe("Filter by key or path substring"),
        limit: z.number().int().min(1).max(100).optional().describe("Default 20"),
      },
      annotations: READ,
    },
    ({ query, limit }) =>
      run(async () => {
        const needle = query?.toLowerCase();
        const all = (await store.listProjects()).filter(
          (p) => !needle || `${p.key} ${p.project_path ?? ""}`.toLowerCase().includes(needle),
        );
        return {
          current: (await session.get()).project,
          total: all.length,
          projects: all.slice(0, limit ?? 20).map((p) => ({
            key: p.key, path: p.project_path ?? undefined, updated: day(p.updated_at),
          })),
        };
      }),
  );

  // ─── Notes ────────────────────────────────────────────

  server.registerTool(
    "get_context",
    {
      title: "Get session notes",
      description: "Recent saved notes for this project (project-wide notes plus the current branch and PR). Long notes are clipped unless full is set.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
        type: z.enum(ENTRY_TYPES).optional(),
        full: z.boolean().optional().describe("Return whole notes instead of the first 600 characters"),
      },
      annotations: READ,
    },
    ({ limit, type, full }) =>
      run(async () => {
        const s = (await session.get());
        const { entries } = await store.getContext({ project: s.project, branch: s.branch, pr: s.pr, limit, type });
        return {
          project: s.project,
          entries: entries.map((e) => ({
            id: e.id, type: e.type, scope: e.scope, title: e.title,
            content: full ? e.content : clip(e.content, 600),
            tags: e.tags ?? undefined, at: day(e.created_at),
          })),
        };
      }),
  );

  server.registerTool(
    "save_memory",
    {
      title: "Save a note",
      description:
        "Save a session note (what was done, decided or found) for this project. Use remember for durable facts; use this for narrative.",
      inputSchema: {
        content: z.string().describe("Details"),
        title: z.string().optional().describe("One-line summary; derived from the content when omitted"),
        type: z
          .string()
          .optional()
          .describe(`One of ${ENTRY_TYPES.join(", ")}; anything else is stored as a note. Default note`),
        tags: z.string().optional().describe("Comma-separated"),
        scope: z.enum(SCOPES).optional().describe("Default project: visible from every branch"),
      },
      annotations: WRITE,
    },
    ({ content, title, type, tags, scope }) =>
      run(async () => {
        const s = (await session.get());
        const wanted = (type ?? "note").trim().toLowerCase();
        const known = (ENTRY_TYPES as readonly string[]).includes(wanted);
        const effective = scope ?? "project";
        const scopeRef = effective === "pr" ? s.pr : effective === "branch" ? s.branch : null;
        const extraTags = [known ? null : wanted, s.branch ? `branch:${s.branch}` : null].filter(Boolean);
        const allTags = [tags, ...extraTags].filter(Boolean).join(",") || undefined;

        const saved = await store.saveEntry({
          project: s.project,
          type: known ? wanted : "note",
          title: title?.trim() || clip(content.replace(/\s+/g, " ").trim(), 80),
          content,
          tags: allTags,
          scope: effective,
          scope_ref: scopeRef,
        });
        return { saved: saved.id, scope: saved.scope };
      }),
  );

  // ─── Knowledge graph ──────────────────────────────────

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Create or update a knowledge-graph entity and add facts to it (an existing name is extended, duplicates are skipped). One fact per item, under 1000 characters; the name stays short. Add keywords so later searches find it. Entities named in the facts are linked automatically, and facts that seem to contradict a stored one come back as possible_conflicts. Scope 'global' is for facts about the user that hold in every project.",
      inputSchema: {
        name: z.string().max(80, "Use a short name (up to 80 characters); put the sentence in observations"),
        entity_type: entityType.optional().describe("Default concept"),
        observations: z.array(z.string()).optional().describe("Facts about the entity"),
        keywords: z
          .array(z.string())
          .optional()
          .describe("Other words a later search might use: synonyms, abbreviations, the term in the user's language. Search has no meaning-based matching, so these matter"),
        summary: z.string().optional(),
        importance: z.number().min(0).max(1).optional().describe("0-1; defaults by type (pitfall .8, convention .75, decision .7 ... file .4)"),
        scope: z.enum(["project", "global"]).optional(),
      },
      annotations: WRITE,
    },
    ({ name, entity_type, observations, keywords, summary, importance, scope }) =>
      run(async () => {
        const project = scope === "global" ? GLOBAL_PROJECT : (await session.get()).project;
        return store.upsertEntity({
          project, name, entity_type: entity_type ?? "concept", summary, importance, observations, keywords,
        });
      }),
  );

  server.registerTool(
    "correct_fact",
    {
      title: "Correct a fact",
      description: "Replace a wrong or outdated fact (by the id recall and what_do_i_know show), or retire it by omitting new_fact.",
      inputSchema: {
        fact_id: z.string(),
        new_fact: z.string().optional().describe("Replacement; omit to just invalidate"),
      },
      annotations: DESTRUCTIVE,
    },
    ({ fact_id, new_fact }) =>
      run(async () => store.correctFact({ project: (await session.get()).project, observation_id: fact_id, new_fact })),
  );

  server.registerTool(
    "link",
    {
      title: "Link entities",
      description: "Connect two existing entities, or with remove: true disconnect them. Types are needed only when a name matches more than one entity.",
      inputSchema: {
        from: z.string().describe("Source entity name"),
        to: z.string().describe("Target entity name"),
        relation: z.enum(RELATION_TYPES).optional().describe("Default relates_to"),
        from_type: entityType.optional(),
        to_type: entityType.optional(),
        context: z.string().optional().describe("Why they are related"),
        remove: z.boolean().optional().describe("Remove the link instead (all types unless relation is given)"),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    ({ from, to, relation, from_type, to_type, context, remove }) =>
      run(async () => {
        if (remove) {
          return store.unlink({ project: (await session.get()).project, from_name: from, from_type, to_name: to, to_type, relation_type: relation });
        }
        try {
          return await store.link({
            project: (await session.get()).project,
            from_name: from, from_type, to_name: to, to_type,
            relation_type: relation ?? "relates_to", context,
          });
        } catch (error) {
          if (error instanceof StoreError && error.code === "not_found") {
            throw new StoreError("not_found", `${error.message}. Create it with remember first.`);
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description:
        "Search memory by keywords: graph entities with their dated facts, linked entities as related, and matching notes. Matching ignores accents, finds word starts and stems, and falls back to parts of words; it is not meaning-based, so search with the words, synonyms and both languages the facts would use. Includes global facts. Start work with this.",
      inputSchema: {
        query: z.string(),
        entity_type: entityType.optional(),
        limit: z.number().int().min(1).max(20).optional().describe("Default 10"),
        all_projects: z.boolean().optional().describe("Search every project, not just this one"),
      },
      annotations: READ,
    },
    ({ query, entity_type, limit, all_projects }) =>
      run(async () => {
        const s = (await session.get());
        const found = await store.recall({ project: s.project, q: query, entity_type, limit, all_projects });
        return {
          entities: found.entities.map((e) => shapeEntity(e, s)),
          related: found.related.length ? found.related.map((r) =>
            r.outgoing ? `${r.via} ${r.relation} ${r.name} (${r.entity_type})` : `${r.name} (${r.entity_type}) ${r.relation} ${r.via}`) : undefined,
          notes: found.entries.map((e) => ({
            id: e.id, type: e.type, title: e.title, snippet: e.content, at: day(e.created_at),
            ...(e.project_key !== s.project ? { project: e.project_key } : {}),
          })),
        };
      }),
  );

  server.registerTool(
    "what_do_i_know",
    {
      title: "Entity detail",
      description: "Everything about one entity: dated facts, direct relations and neighbours up to two hops away.",
      inputSchema: { name: z.string(), entity_type: entityType.optional() },
      annotations: READ,
    },
    ({ name, entity_type }) =>
      run(async () => {
        const s = (await session.get());
        const d = await store.describe({ project: s.project, name, entity_type });
        const rel = (r: Row, other: "target" | "source") => ({
          relation: r.relation_type, [other]: `${r[`${other}_name`]} (${r[`${other}_type`]})`, why: r.context ?? undefined,
        });
        return {
          name: d.entity.name,
          type: d.entity.entity_type,
          summary: d.entity.summary ?? undefined,
          importance: d.entity.importance,
          facts: d.observations.map(fact),
          out: d.relations.outgoing.map((r) => rel(r, "target")),
          in: d.relations.incoming.map((r) => rel(r, "source")),
          neighbours: d.graph_neighbors.map((n) => ({ name: n.name, type: n.entity_type, hops: n.hop })),
        };
      }),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget an entity",
      description: "Retire an entity with its facts and relations. It stops appearing in searches; the data stays in the database.",
      inputSchema: { name: z.string(), entity_type: entityType.optional() },
      annotations: DESTRUCTIVE,
    },
    ({ name, entity_type }) => run(async () => store.forget({ project: (await session.get()).project, name, entity_type })),
  );

  server.registerTool(
    "graph_stats",
    {
      title: "Graph health",
      description:
        "Counts of entities, relations, facts and notes, orphan entities (no relations) and the top entities. With check: also old low-importance entities and notes, and file entities whose path no longer exists.",
      inputSchema: {
        check: z.boolean().optional().describe("Also list cleanup candidates"),
        max_age_days: z.number().int().min(1).optional().describe("Age threshold for check, default 90"),
      },
      annotations: READ,
    },
    ({ check, max_age_days }) =>
      run(async () => {
        const s = (await session.get());
        const stats = await store.graphStats(s.project);
        if (!check) return { project: s.project, ...stats };

        const found = await store.consolidate({ project: s.project, max_age_days });
        let missing: string[] = [];
        if (s.project_path && ctx.fileExists) {
          const root = s.project_path;
          const exists = ctx.fileExists;
          missing = (await store.entityNames(s.project, "file")).filter((n) => looksLikePath(n) && !exists(root, n));
        }
        return {
          project: s.project,
          ...stats,
          old_entities: found.entity_candidates.map((e) => ({ name: e.name, type: e.entity_type, importance: e.importance, facts: e.observation_count })),
          old_notes: found.entry_candidates.map((e) => ({ id: e.id, type: e.type, title: e.title, at: day(e.created_at) })),
          missing_files: missing,
        };
      }),
  );

  if (ctx.rules) {
    const rules = ctx.rules;
    server.registerTool(
      "rules",
      {
        title: "User rules",
        description:
          "The user's standing rules for this project, organization and device, as injected at session start. action 'show' returns them. action 'propose' queues a rule the user explicitly asked to make standing; the user approves it in the panel, the web page or the CLI. Preferences you pick up from the conversation go to the taste tool instead. Never propose secrets or one-off instructions.",
        inputSchema: {
          action: z.enum(["show", "propose"]),
          scope: z.enum(["global", "device", "org", "project", "project_device"]).optional().describe("For propose. global: everywhere. device: this machine. org: the organization of this repo. project: this project. project_device: this project on this machine."),
          text: z.string().max(1500).optional().describe("For propose: the rule, short and imperative"),
          mode: z.enum(["append", "replace"]).optional().describe("For propose. Default append"),
          reason: z.string().max(400).optional().describe("For propose: why, so the user can judge it"),
        },
        annotations: WRITE,
      },
      ({ action, scope, text, mode, reason }) =>
        run(async () => {
          if (action === "show") {
            const r = await rules.show();
            return {
              rules: r.text || "(none set)",
              sections: r.parts.map((p) => `${p.label} (${p.chars} chars)`),
              pending_proposals: r.pending || undefined,
              note: r.stale ? "Read from the local cache: the server could not be reached." : undefined,
            };
          }
          if (!scope || !text?.trim()) throw new StoreError("invalid", "propose needs scope and text");
          const made = await rules.propose({ scope, text, mode, reason });
          return {
            proposal: made.id,
            status: "pending",
            note: "Queued. The user decides: panel (/brain, Rules), the web page, or `task-runner-mcp rules approve " + made.id + "`. It is not active yet.",
          };
        }),
    );
  }

  server.registerTool(
    "taste",
    {
      title: "Learned preferences",
      description:
        "How the user wants things, learned from what they said: style, workflow, wording, tools. They are injected at session start and apply at once, with no approval. action 'show' lists them with ids. action 'learn' records what a message taught: 'new' for a wish not seen before, 'reinforce' when they say an existing one again, 'refine' when they adjust it, 'replace' when they now want something different on the same point, 'drop' when they take it back. Write each rule as a general, short instruction (one step more general than the message, never their words as a log). scope 'global' for how they work everywhere, 'org' for this organization, 'project' for this codebase. In Claude Code the panel learns these by itself; call learn when the user asks you to remember how they want something. Never store secrets or people's private data.",
      inputSchema: {
        action: z.enum(["show", "learn", "forget"]),
        items: z
          .array(
            z.object({
              action: z.enum(["new", "reinforce", "refine", "replace", "drop"]).optional(),
              id: z.string().optional().describe("The existing preference, for reinforce, refine, replace and drop"),
              scope: z.enum(["global", "org", "project"]).optional(),
              area: z.string().max(40).optional().describe("A short topic: workflow, commits, replies, ui, testing..."),
              rule: z.string().max(300).optional(),
            }),
          )
          .max(20)
          .optional()
          .describe("For learn"),
        id: z.string().optional().describe("For forget"),
      },
      annotations: WRITE,
    },
    ({ action, items, id }) =>
      run(async () => {
        const s = await session.get();
        if (action === "forget") {
          if (!id) throw new StoreError("invalid", "forget needs id");
          return store.tasteForget(id);
        }
        if (action === "learn") {
          if (!items?.length) throw new StoreError("invalid", "learn needs items");
          return store.tasteLearn({ project: s.project, org: s.org, source: "agent", items });
        }
        const rows = await store.tasteList({ project: s.project, org: s.org });
        return {
          preferences: rows.map((r) => ({ id: r.id, scope: r.scope, area: r.area, rule: r.rule, confidence: r.confidence, hits: r.hits })),
        };
      }),
  );

  if (ctx.worklog) {
    const worklog = ctx.worklog;
    server.registerTool(
      "worklog",
      {
        title: "Time report",
        description:
          "How long the user and the agent worked, per project and task (a branch or ticket), for a period. Read from the session transcripts. Use it to answer 'how much time did I spend on X this week' or 'what did I do this week'. Agent time adds up across parallel sessions; wall time counts each minute once.",
        inputSchema: {
          range: z.enum(["today", "yesterday", "week", "last-week", "month", "custom"]).optional().describe("Default week (Monday to Sunday)"),
          from: z.string().optional().describe("YYYY-MM-DD, with range custom"),
          to: z.string().optional().describe("YYYY-MM-DD, with range custom"),
          project: z.string().optional().describe("A project key, or 'current'. Default: every project"),
          detail: z.boolean().optional().describe("Include what was asked and the notes and commits per task"),
        },
        annotations: READ,
      },
      ({ range, from, to, project, detail }) =>
        run(async () =>
          worklog({
            range: range ?? "week",
            from,
            to,
            project: project === "current" ? (await session.get()).project : (project ?? null),
            detail,
          }),
        ),
    );
  }

  // ─── Tasks ────────────────────────────────────────────

  server.registerTool(
    "create_task_group",
    {
      title: "Create a task group",
      description:
        "Split work into ordered tasks, from markdown ('## Task 1: Title' sections) or a tasks array. Then loop get_next_task, do the task (ideally in a subagent), complete_task.",
      inputSchema: {
        name: z.string().describe("Group name"),
        markdown: z.string().optional(),
        tasks: z.array(z.object({ title: z.string(), content: z.string() })).optional(),
        system_prompt: z.string().optional().describe("Shared instructions returned with every task"),
        replace: z.boolean().optional().describe("Overwrite an existing group that has progress"),
      },
      annotations: WRITE,
    },
    ({ name, markdown, tasks, system_prompt, replace }) =>
      run(async () => {
        const list = markdown ? parseTaskMarkdown(markdown) : tasks;
        if (!list?.length) {
          throw new StoreError("invalid", "Provide markdown with '## Task N: Title' sections, or a non-empty tasks array");
        }
        return store.createTasks({
          project: (await session.get()).project, task_group: slugify(name), tasks: list, system_prompt, replace,
          branch: (await session.get()).branch ?? null,
        });
      }),
  );

  server.registerTool(
    "get_next_task",
    {
      title: "Next task",
      description: "Claim the next pending task and mark it running. A task running for over 30 minutes counts as abandoned and is offered again.",
      inputSchema: { task_group: z.string().optional().describe("Defaults to the latest group") },
      annotations: { ...WRITE, idempotentHint: false },
    },
    ({ task_group }) => run(async () => {
        const s = (await session.get());
        return store.nextTask({ project: s.project, task_group, branch: s.branch ?? null });
      }),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Finish a task",
      description: "Record the outcome of a task: done with its result, or failed with the reason. Elapsed time is measured automatically.",
      inputSchema: {
        task_id: z.string().describe("e.g. task-001"),
        result: z.string().describe("The result, or the failure reason when status is failed"),
        status: z.enum(["done", "failed"]).optional().describe("Default done"),
        task_group: z.string().optional(),
      },
      annotations: WRITE,
    },
    ({ task_id, result, status, task_group }) =>
      run(async () => {
        const project = (await session.get()).project;
        return status === "failed"
          ? store.failTask({ project, task_id, error: result, task_group })
          : store.completeTask({ project, task_id, result, task_group });
      }),
  );

  server.registerTool(
    "get_task_status",
    {
      title: "Task status",
      description: "Summary counts and every task's status for a group; with task_id, that task in full including its result or error.",
      inputSchema: {
        task_group: z.string().optional().describe("Defaults to the latest group"),
        task_id: z.string().optional(),
      },
      annotations: READ,
    },
    ({ task_group, task_id }) =>
      run(async () => {
        const s = (await session.get());
        const project = s.project;
        if (task_id) return store.taskResult({ project, task_id, task_group });
        const status = (await store.taskStatus({ project, task_group, branch: s.branch ?? null })) as {
          task_group: string;
          tasks: Row[];
        };
        return { summary: await store.taskSummary(project, status.task_group), tasks: status.tasks };
      }),
  );

  server.registerTool(
    "clear_tasks",
    {
      title: "Clear tasks",
      description: "Delete one task group, or all task groups of this project. Memory is not touched.",
      inputSchema: { task_group: z.string().optional().describe("Omit to clear every group") },
      annotations: DESTRUCTIVE,
    },
    ({ task_group }) => run(async () => store.clearTasks({ project: (await session.get()).project, task_group })),
  );
}
