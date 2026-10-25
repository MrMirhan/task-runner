/**
 * unicode61 folds accents but not the dotless Turkish i, so both sides of a search
 * are folded the same way before they reach the index.
 */
export function fold(text: string): string {
  return text.replace(/ı/g, "i").replace(/İ/g, "I");
}

/** SQL twin of fold() for INSERT ... SELECT statements. */
export const foldSql = (column: string): string => `replace(replace(${column}, 'ı', 'i'), 'İ', 'I')`;

const STOPWORDS = new Set(
  (
    "a an and are as at be been by do does did for from has have had if in is it its of on or so that the their then there these this to was were what when where which who will with would you your i we they he she not but can could should " +
    "ve veya ile bir bu su o icin için gibi de da mi mu ne ama cok çok daha en olarak olan olur var yok her ya ki"
  ).split(" "),
);

/**
 * Builds a safe FTS5 MATCH expression: unicode-aware tokens, prefix-matched, OR-joined.
 * bm25 ranking puts documents that match more terms first.
 */
export function ftsQuery(input: string): string | null {
  const tokens = fold(input).match(/[\p{L}\p{N}_]+/gu);
  if (!tokens) return null;
  const all = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const content = all.filter((t) => !STOPWORDS.has(t));
  const unique = (content.length > 0 ? content : all).slice(0, 12);
  const terms = new Set<string>();
  for (const t of unique) {
    terms.add(t.length >= 2 ? `"${t}"*` : `"${t}"`);
    // A shorter stem also matches other inflections: "çalışmaları" finds "çalışma", "deployment" finds "deploying".
    // Six letters keep the root of most Turkish and English words while dropping the suffix chain.
    if (t.length >= 7) terms.add(`"${t.slice(0, Math.max(5, Math.min(6, t.length - 2)))}"*`);
    // A plural in the question still finds the singular that was stored.
    else if (t.length >= 4 && /[^siu]s$/.test(t)) terms.add(`"${t.slice(0, -1)}"*`);
  }
  return [...terms].join(" OR ");
}

/** Phrases for the trigram index: whole tokens of three or more characters. */
export function trigramQuery(input: string): string | null {
  const tokens = fold(input).toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu);
  if (!tokens) return null;
  const content = tokens.filter((t) => !STOPWORDS.has(t));
  return [...new Set(content.length ? content : tokens)].slice(0, 12).map((t) => `"${t}"`).join(" OR ");
}

/** Lowercased word set used for similarity checks between facts. */
export function wordSet(text: string): Set<string> {
  return new Set((fold(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t)));
}
