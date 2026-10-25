import type { Row } from "./db.ts";
import type { ExportData } from "./store.ts";

export interface VaultFile {
  path: string;
  content: string;
}

const slug = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "untitled";

const day = (seconds: unknown): string =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";

/** Renders an export as an Obsidian-style vault: one file per entity, wiki links for relations. */
export function renderVault(data: ExportData): VaultFile[] {
  const files: VaultFile[] = [];
  const t = data.tables;
  const live = <T extends Row>(rows: T[] | undefined): T[] => (rows ?? []).filter((r) => r.valid_until == null);

  const entities = live(t.entities);
  const facts = live(t.observations);
  const relations = live(t.relations);

  const fileOf = new Map<string, string>();
  const used = new Set<string>();
  for (const e of entities) {
    let name = slug(String(e.name));
    if (used.has(`${e.project_key}/${name}`)) name = `${name}-${e.entity_type}`;
    used.add(`${e.project_key}/${name}`);
    fileOf.set(String(e.id), name);
  }
  const byId = new Map(entities.map((e) => [String(e.id), e]));
  const link = (id: string) => `[[${fileOf.get(id)}|${byId.get(id)?.name}]]`;

  for (const e of entities) {
    const id = String(e.id);
    const out = relations.filter((r) => r.source_id === id && byId.has(String(r.target_id)));
    const incoming = relations.filter((r) => r.target_id === id && byId.has(String(r.source_id)));
    const lines = [
      "---",
      `type: ${e.entity_type}`,
      `project: ${e.project_key}`,
      `importance: ${e.importance}`,
      `updated: ${day(e.updated_at)}`,
      `tags: [${e.entity_type}]`,
      "---",
      `# ${e.name}`,
      "",
    ];
    if (e.summary) lines.push(String(e.summary), "");
    const own = facts.filter((f) => f.entity_id === id);
    if (own.length) lines.push("## Facts", ...own.map((f) => `- ${f.content}`), "");
    if (out.length || incoming.length) {
      lines.push(
        "## Relations",
        ...out.map((r) => `- ${r.relation_type} ${link(String(r.target_id))}${r.context ? ` — ${r.context}` : ""}`),
        ...incoming.map((r) => `- ${link(String(r.source_id))} ${r.relation_type} this${r.context ? ` — ${r.context}` : ""}`),
        "",
      );
    }
    files.push({ path: `${e.project_key}/entities/${fileOf.get(id)}.md`, content: lines.join("\n") });
  }

  const projects = new Set<string>([
    ...entities.map((e) => String(e.project_key)),
    ...(t.entries ?? []).map((e) => String(e.project_key)),
  ]);

  for (const project of projects) {
    const index = [`# ${project}`, ""];
    const mine = entities.filter((e) => e.project_key === project);
    for (const type of [...new Set(mine.map((e) => String(e.entity_type)))].sort()) {
      index.push(`## ${type}`, ...mine.filter((e) => e.entity_type === type).map((e) => `- ${link(String(e.id))}`), "");
    }
    files.push({ path: `${project}/README.md`, content: index.join("\n") });

    const notes = (t.entries ?? [])
      .filter((e) => e.project_key === project)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at));
    if (notes.length) {
      const lines = [`# Notes — ${project}`, ""];
      for (const n of notes) {
        lines.push(`## ${n.title}`, `*${n.type} · ${n.scope}${n.scope_ref ? `:${n.scope_ref}` : ""} · ${day(n.created_at)}*`, "", String(n.content), "");
      }
      files.push({ path: `${project}/notes.md`, content: lines.join("\n") });
    }
  }

  return files;
}
