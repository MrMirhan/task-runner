import type { TasteRow } from "./store.ts";

const MAX_CHARS = 3000;

const strength = (r: Pick<TasteRow, "confidence" | "hits">) =>
  r.confidence >= 0.85 ? "firm" : r.hits > 1 ? `said ${r.hits} times` : "said once";

/** The section the session hook injects. Firmest first; it stops before the budget instead of cutting a line. */
export function formatTaste(rows: TasteRow[], maxChars = MAX_CHARS): string {
  if (rows.length === 0) return "";
  const head =
    "## How the user wants things (learned from what they said)\nFollow these unless the current request says otherwise. When it does, the newer wish wins.";
  const lines: string[] = [];
  let used = head.length;
  for (const r of rows) {
    const where = r.scope === "global" ? "" : r.scope === "org" ? ` [org ${r.ref}]` : "";
    const line = `- ${r.area}: ${r.rule} (${strength(r)})${where}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return [head, ...lines].join("\n");
}
