export interface TaskInput {
  title: string;
  content: string;
}

/** Parses `## Task N: Title` sections; also accepts `## Title` when no numbered headings exist. */
export function parseTaskMarkdown(markdown: string): TaskInput[] {
  const numbered = /^##\s+Task\s+\d+\s*[:.-]\s*(.+)$/gim;
  let headings = collect(markdown, numbered);
  if (headings.length === 0) {
    headings = collect(markdown, /^##\s+(?!#)(.+)$/gm);
  }

  return headings.map((h, i) => {
    const bodyStart = markdown.indexOf("\n", h.index);
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].index : markdown.length;
    const content = bodyStart === -1 || bodyStart >= bodyEnd ? "" : markdown.slice(bodyStart + 1, bodyEnd).trim();
    return { title: h.title, content: content || h.title };
  });
}

function collect(markdown: string, regex: RegExp): Array<{ title: string; index: number }> {
  const out: Array<{ title: string; index: number }> = [];
  for (const m of markdown.matchAll(regex)) {
    out.push({ title: m[1].trim(), index: m.index ?? 0 });
  }
  return out;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "tasks";
}
