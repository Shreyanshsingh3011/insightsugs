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
  "explicitly","mentioned","mention","column","columns","field","fields",
  "open","phone","number","email","mail","mobile","contact","responsible","person","owner","owners",
]);

/** Header aliases that mean "row identifier / serial number". Kept broad so
 * question phrasings like "S. No. 67", "sr no 12", "sl no 4", "SNO 9" all
 * resolve to the identifier column regardless of the sheet's label spelling. */
export const SNO_ALIASES = [
  "s.no","s.no.","s no","sno","sr","sr.","sr no","sr.no","sr.no.","srno",
  "sl","sl.","sl no","sl.no","sl.no.","slno","serial","serial no","serial number",
  "s/n","s / n","#","no.","no",
];

/** Header aliases that mean "activity / task / name". Used to describe which
 * columns we searched when a strict match fails, so the user sees an
 * actionable "not found in X columns" message instead of a silent grounding
 * failure. */
export const NAME_ALIASES = [
  "activity","activity name","task","task name","name","full name","beneficiary",
  "beneficiary name","applicant","applicant name","owner","assignee","responsible",
  "vendor","contractor","material","item","kpi","bill no","po no","contract",
];


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

function isCodeLikeToken(token: string): boolean {
  if (/\d/.test(token)) return true;
  if (token.length <= 3) return true;
  // Acronyms often arrive lower-cased by normalization (NBPDCL -> nbpdcl).
  // They should be matched as row-level tokens, not as part of one long
  // contiguous natural-language phrase.
  return token.length >= 4 && !/[aeiou]/.test(token);
}

function phraseCanMatchAcrossColumns(phrase: string): boolean {
  const parts = phrase.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.some(isCodeLikeToken);
}

/**
 * Strict but sheet-friendly matching. Natural names still require a contiguous
 * phrase ("Kunti Devi" never becomes surname-only matching), while code-like
 * lookups such as "NBPDCL NIT 48 Samastipur" may match when every requested
 * token appears anywhere in the row, even if values are split across columns.
 */
export function matchesExactTarget(hay: string, phrases: string[], tokens: string[]): boolean {
  if (phrases.length === 0) return tokens.length > 0 && tokens.every((t) => phraseHit(hay, t));
  if (matchesAllPhrases(hay, phrases)) return true;
  if (tokens.length === 0) return false;
  if (!phrases.every(phraseCanMatchAcrossColumns)) return false;
  return tokens.every((t) => phraseHit(hay, t));
}

export function exactTargetScore(hay: string, phrases: string[], tokens: string[]): number {
  if (phrases.length > 0 && matchesAllPhrases(hay, phrases)) return 20 + tokens.length;
  if (matchesExactTarget(hay, phrases, tokens)) return 10 + tokens.length;
  return 0;
}

/** Count how many strict phrases hit — for graceful "partial match" fallback. */
export function countPhraseHits(hay: string, phrases: string[]): number {
  let n = 0;
  for (const p of phrases) if (phraseHit(hay, p)) n++;
  return n;
}

/**
 * Fuzzy variant: any phrase that looks like a name (2+ alphabetic tokens
 * and no digits) may match via Levenshtein window scan when strict misses.
 * Use ONLY as a fallback after `matchesAllPhrases` returns zero rows —
 * strict correctness is still the default. Import `fuzzyNameInText` from
 * `@/lib/person-resolver` at the call site.
 */
export function matchesAllPhrasesFuzzy(
  hay: string,
  phrases: string[],
  fuzzy: (name: string, text: string) => boolean,
): boolean {
  if (phrases.length === 0) return true;
  for (const p of phrases) {
    if (phraseHit(hay, p)) continue;
    const isNameish = /^[a-z]+(?:\s+[a-z]+)+$/.test(p);
    if (isNameish && fuzzy(p, hay)) continue;
    return false;
  }
  return true;
}

/** True when the query is specific enough that unrelated rows are unsafe. */
export function hasStrictTarget(query: string): boolean {
  return strictPhrases(query).length > 0;
}

// ─────────────── Serial number / row-id extraction ───────────────
// Some questions target a row by its serial number ("show me sno 67",
// "details for S. No. 12"). Extract that so the deterministic engine can
// look the row up by SNO_ALIASES header, rather than trying to string-match
// "67" across every cell and returning a random row that mentions 67.
export function extractSerialNumber(query: string): number | null {
  const m = query.match(/\b(?:s|sr|sl|serial|sno)\s*\.?\s*(?:no|number|num|#)?\s*\.?\s*[:#-]?\s*(\d{1,6})\b/i);
  if (m) return Number(m[1]);
  return null;
}

/** Return the row's serial-number value (as string) if a SNO alias exists. */
export function rowSerialNumber(row: Record<string, unknown>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = new Set(SNO_ALIASES.map(norm));
  for (const [k, v] of Object.entries(row)) {
    if (!wanted.has(norm(k))) continue;
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return null;
}

/**
 * When a strict match returns 0 rows, produce a helpful description of what
 * we actually searched. Used by copilot to reply "I searched columns
 * Activity, Beneficiary, Owner across 3 sheets and didn't find 'Manka Bibi'"
 * instead of a generic grounding failure.
 */
export function describeSearchedColumns(
  sheets: Array<{ display_name: string; headers?: string[] }>,
): string {
  const cols = new Set<string>();
  for (const s of sheets) for (const h of s.headers ?? []) cols.add(h);
  const relevant = Array.from(cols).filter((h) => {
    const hn = h.toLowerCase();
    return NAME_ALIASES.some((a) => hn.includes(a));
  });
  if (relevant.length === 0) return Array.from(cols).slice(0, 6).join(", ");
  return relevant.slice(0, 6).join(", ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWholePhrase(hay: string, phrase: string): boolean {
  if (!phrase) return false;
  const escaped = escapeRegExp(phrase).replace(/\\\s\+/g, "\\s+");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(hay);
}

/**
 * Detect columns explicitly requested by the user, e.g.
 * "in the Store or Contractor column". This prevents the Copilot from
 * matching the target phrase anywhere in the row when the question names a
 * specific source column/field.
 */
export function extractRequestedColumns(query: string, availableColumns: string[]): string[] {
  const q = normalizeText(query);
  if (!/\b(columns?|fields?)\b/.test(q)) return [];

  const quoted = new Set<string>();
  const qre = /["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{2,})["'\u201c\u201d\u2018\u2019]/g;
  let m: RegExpExecArray | null;
  while ((m = qre.exec(query))) {
    const p = normalizeText(m[1]);
    if (p) quoted.add(p);
  }

  const hits: string[] = [];
  const seen = new Set<string>();
  for (const col of availableColumns) {
    const c = normalizeText(col);
    if (!c || seen.has(c)) continue;
    if (quoted.has(c) || hasWholePhrase(q, c)) {
      hits.push(col);
      seen.add(c);
    }
  }
  return hits;
}

