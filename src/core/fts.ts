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
  return unique.map((t) => (t.length >= 2 ? `"${t}"*` : `"${t}"`)).join(" OR ");
}
