import type { Store } from "../core/store.ts";

type Digest = ReturnType<Store["digest"]>;
type DigestEntity = Digest["entities"][number];

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const line = (e: DigestEntity): string => {
  const detail = [e.summary, ...e.facts].filter(Boolean).map((s) => clip(String(s), 140));
  return `- ${e.entity_type} ${e.name}${detail.length ? `: ${detail.join("; ")}` : ""}`;
};

const day = (seconds: unknown): string =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";

export interface DigestHeader {
  project: string;
  branch?: string | null;
}

/** The session-start brief: what the model needs to recall before its first reply. */
export function formatDigest(header: DigestHeader, d: Digest): { context: string; status: string } {
  const { stats } = d;
  const empty = stats.entities === 0 && stats.entries === 0 && d.global_entities.length === 0;
  const head = `task-runner memory for "${header.project}"${header.branch ? ` (branch ${header.branch})` : ""}`;

  if (empty) {
    return {
      status: `task-runner: ${header.project} · no memory yet`,
      context: `${head}: nothing stored yet. As you learn durable facts (decisions, pitfalls, conventions) record them with remember; use save_memory for session notes.`,
    };
  }

  const lines = [`${head}: ${stats.entities} entities, ${stats.relations} relations, ${stats.entries} notes.`];
  if (d.global_entities.length) lines.push("About the user (all projects):", ...d.global_entities.map(line));
  if (d.entities.length) lines.push("Project knowledge, most important first:", ...d.entities.map(line));
  if (d.entries.length) {
    lines.push("Recent notes:", ...d.entries.map((e) => `- [${e.type}] ${clip(String(e.title), 100)} (${day(e.created_at)})`));
  }
  if (d.tasks && d.tasks.pending + d.tasks.running > 0) {
    lines.push(
      `Open task group "${d.tasks.task_group}": ${d.tasks.completed}/${d.tasks.total} done, ${d.tasks.running} running, ${d.tasks.pending} pending. Continue with get_next_task.`,
    );
  }
  lines.push("Run recall(query) for details before re-deriving anything. If the code contradicts a fact, the code is right: fix it with correct_fact.");

  return {
    status: `task-runner: ${header.project} · ${stats.entities} entities · ${stats.entries} notes`,
    context: lines.join("\n"),
  };
}
