// Strict query-matching helpers shared by the deterministic engine and the
// agent's keyword-scan fallback.
//
// Contract: answer EXACTLY what the user asked. When the user asks about
// "Kunti Devi", we must not surface "Ram Devi" or any other row that just
// happens to contain the surname. To achieve that we:
//   1. Extract "strict phrases" from the query — quoted phrases, capitalised
//      multi-word runs (proper nouns), AND the full content-token phrase
//      (query minus stopwords) when it is 2+ tokens.
//   2. Normalise both the row haystack and the phrase (collapse whitespace,
//      lowercase, strip punctuation) so "Kunti  Devi\n" still matches
//      "kunti devi".
//   3. A row matches ONLY if every strict phrase appears as a contiguous
//      substring in the normalised haystack. Callers must NOT fall back to
//      per-token AND matching when strict phrases exist and none match —
//      that's what leaks unrelated rows.

const STOP = new Set([
  "the","a","an","and","or","of","in","on","for","to","with","is","are","was","were","be","by",
  "how","many","what","which","show","list","give","tell","me","find","get","all","any","from",
  "please","can","you","do","does","did","will","that","this","these","those","some","most","have",
  "has","had","not","no","yes","about","into","over","under","between","across","per","each",
  "count","total","sum","average","avg","mean","min","max","top","bottom","highest","lowest",
  "current","status","project","projects","row","rows","sheet","sheets","doc","docs","document",
  "documents","data","information","summarize","summary","summarise","details","detail","info",
  "regarding","related","about","concerning","named","called","entry","record","records",
  "open","phone","number","email","mail","mobile","contact","responsible","person","owner","owners",
]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentTokens(query: string): string[] {
  return normalizeText(query)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/**
 * Extract required contiguous phrases from the query.
 * Priority:
 *   - Quoted phrases (single or double quotes) — always required verbatim.
 *   - Capitalised multi-word runs (proper nouns like "Kunti Devi").
 *   - The full content-token phrase when the query has 2+ content tokens
 *     (so "phone number of arpita das" → require "arpita das" as a phrase).
 */
export function strictPhrases(query: string): string[] {
  const out = new Set<string>();
  let hasExplicitTarget = false;

  const qre = /["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{2,})["'\u201c\u201d\u2018\u2019]/g;
  let m: RegExpExecArray | null;
  while ((m = qre.exec(query))) {
    const p = normalizeText(m[1]);
    if (p) {
      out.add(p);
      hasExplicitTarget = true;
    }
  }

  const pre = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g;
  while ((m = pre.exec(query))) {
    const p = normalizeText(m[1]);
    if (p) {
      out.add(p);
      hasExplicitTarget = true;
    }
  }

  // Identifier-like tokens: anything with a digit (IT76, IT-76, #123, 45678),
  // or all-caps codes 2+ chars (SKU, GSTIN). These MUST appear verbatim —
  // "76" and "77" are not the same project.
  const idRe = /\b([A-Za-z]*\d+[A-Za-z0-9-]*|\d+[A-Za-z][A-Za-z0-9-]*|[A-Z]{2,}[A-Z0-9-]*)\b/g;
  while ((m = idRe.exec(query))) {
    const raw = m[1];
    // Skip plain year-like tokens only if part of a longer date phrase — safest to keep.
    const p = normalizeText(raw);
    if (p && p.length >= 2) {
      out.add(p);
      hasExplicitTarget = true;
    }
  }

  const tokens = contentTokens(query);
  // Only synthesize a full lower-case phrase when the query did not already
  // expose a proper noun / quoted target / identifier. Otherwise questions
  // like "what is open with Jai Singh in Nit 76" incorrectly require the
  // artificial contiguous phrase "jai singh nit 76", even though the row may
  // store the person and project in separate columns.
  if (!hasExplicitTarget && tokens.length >= 2) out.add(tokens.join(" "));

  return Array.from(out);
}

export function normalizeHaystack(values: Iterable<unknown>): string {
  const parts: string[] = [];
  for (const v of values) {
    if (v == null) continue;
    parts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return normalizeText(parts.join(" "));
}

/**
 * A row matches strictly when EVERY strict phrase appears as a contiguous
 * substring of the normalised haystack. If there are no strict phrases the
 * caller should fall back to its own per-token logic (this returns true so
 * the caller can decide).
 */
export function matchesAllPhrases(hay: string, phrases: string[]): boolean {
  if (phrases.length === 0) return true;
  for (const p of phrases) if (!hay.includes(p)) return false;
  return true;
}

/** True when the query is specific enough that unrelated rows are unsafe. */
export function hasStrictTarget(query: string): boolean {
  return strictPhrases(query).length > 0;
}
