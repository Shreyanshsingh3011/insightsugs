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

  // Strip serial-number prefixes ("S. No. 67", "Sr No 12", "Sl.No 4",
  // "Serial No 9") — sheets label the column many different ways ("S.No.",
  // "Sr.No.", "S/N"), so requiring the literal "s no" as a contiguous
  // haystack substring produces false negatives. Keep the number as an
  // identifier and drop the prefix.
  const cleaned = query.replace(/\b(?:s|sr|sl|serial|sno|s\.no|sr\.no|sl\.no)\s*\.?\s*(?:no|number|num|#)?\s*\.?\s*(?=\d)/gi, "");

  const qre = /["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{2,})["'\u201c\u201d\u2018\u2019]/g;
  let m: RegExpExecArray | null;
  while ((m = qre.exec(cleaned))) {
    const p = normalizeText(m[1]);
    if (p) { out.add(p); hasExplicitTarget = true; }
  }

  const pre = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g;
  while ((m = pre.exec(cleaned))) {
    const p = normalizeText(m[1]);
    if (p) { out.add(p); hasExplicitTarget = true; }
  }

  // ALL-CAPS multi-word proper nouns ("MANKA BIBI", "MUNNA MANJHI").
  const upre = /\b([A-Z]{2,}(?:\s+[A-Z]{2,})+)\b/g;
  while ((m = upre.exec(cleaned))) {
    const p = normalizeText(m[1]);
    if (p) { out.add(p); hasExplicitTarget = true; }
  }

  // Identifier-like tokens: anything with a digit (IT76, IT-76, #123, 45678),
  // or all-caps codes 2+ chars (SKU, GSTIN).
  const idRe = /\b([A-Za-z]*\d+[A-Za-z0-9-]*|\d+[A-Za-z][A-Za-z0-9-]*|[A-Z]{2,}[A-Z0-9-]*)\b/g;
  while ((m = idRe.exec(cleaned))) {
    const raw = m[1];
    const p = normalizeText(raw);
    if (p && p.length >= 2) { out.add(p); hasExplicitTarget = true; }
  }

  const tokens = contentTokens(cleaned);
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

/** True when a phrase is a pure short number (needs word-boundary match). */
function isShortNumeric(phrase: string): boolean {
  return /^\d{1,4}$/.test(phrase);
}

function phraseHit(hay: string, phrase: string): boolean {
  if (isShortNumeric(phrase)) {
    // Word-boundary so "56" doesn't accidentally match "560" or "1560".
    return new RegExp(`(^|\\D)${phrase}(\\D|$)`).test(hay);
  }
  return hay.includes(phrase);
}

/**
 * A row matches strictly when EVERY strict phrase appears in the normalised
 * haystack (substring for text, word-boundary for short numbers).
 */
export function matchesAllPhrases(hay: string, phrases: string[]): boolean {
  if (phrases.length === 0) return true;
  for (const p of phrases) if (!phraseHit(hay, p)) return false;
  return true;
}

/** Count how many strict phrases hit — for graceful "partial match" fallback. */
export function countPhraseHits(hay: string, phrases: string[]): number {
  let n = 0;
  for (const p of phrases) if (phraseHit(hay, p)) n++;
  return n;
}

/** True when the query is specific enough that unrelated rows are unsafe. */
export function hasStrictTarget(query: string): boolean {
  return strictPhrases(query).length > 0;
}
