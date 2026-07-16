// Deterministic no-LLM answer engine used when the Lovable AI Gateway is
// unavailable (402/quota) AND the Gemini fallback is missing or fails.
// It scans the already-selected sheets/documents and produces a grounded,
// cited answer for the most common question shapes: counts, totals,
// averages, top-N, distributions, keyword lookups, and doc snippet search.
//
// Every returned answer includes `[sheet:Name row N]` or `[doc:Name p.N]`
// citation markers plus a "Sources:" section so it satisfies the same
// citation contract the LLM path uses.

type SheetReg = { id: string; display_name: string; row_count?: number | null };
type DocMeta = { id: string; name: string };

type StoredRow = { row_index: number; data: Record<string, unknown> };
type DocChunk = { document_id: string; page_no: number | null; content: string | null };

export type CopilotRetrievalDiagnostic = {
  sourceId: string;
  sourceName: string;
  sourceType: "sheet" | "document";
  matcherPath: string;
  rowsScanned: number;
  rowsMatched: number;
  columnsSearched?: string[];
};

export type DeterministicLedgerRow = {
  kind: "sheet_row";
  registryId: string;
  sheetLabel: string;
  rowIndex: number;
  data: Record<string, unknown>;
};
export type DeterministicLedgerDoc = {
  kind: "doc_chunk";
  documentId: string;
  documentName: string;
  pageNo: number;
  snippet: string;
};
export type DeterministicLedgerEntry = DeterministicLedgerRow | DeterministicLedgerDoc;

const TERMINAL = /\b(done|closed|complete|completed|delivered|dispatched|resolved|cancelled|canceled)\b/i;

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = cellText(v).replace(/[,₹$€£%()\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

function allColumns(rows: StoredRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) set.add(k);
  return Array.from(set);
}

function pickColumn(cols: string[], patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = cols.find((c) => p.test(c));
    if (hit) return hit;
  }
  return null;
}

function pickNumericColumn(rows: StoredRow[], cols: string[], hint?: string | null): { column: string; values: { row: StoredRow; n: number }[] } | null {
  const candidates = cols.map((c) => {
    const values = rows
      .map((r) => ({ row: r, n: parseNum(r.data[c]) }))
      .filter((x): x is { row: StoredRow; n: number } => x.n != null);
    return { column: c, values };
  });
  const usable = candidates.filter((c) => c.values.length >= Math.max(2, Math.ceil(rows.length * 0.1)));
  if (usable.length === 0) return null;
  if (hint) {
    const re = new RegExp(hint, "i");
    const match = usable.find((c) => re.test(c.column));
    if (match) return match;
  }
  const preferred = usable.find((c) => /amount|total|qty|quantity|value|cost|price|score|days|delay|balance|paid/i.test(c.column));
  return preferred ?? usable[0];
}

import {
  strictPhrases as qmStrictPhrases,
  normalizeHaystack,
  matchesExactTarget,
  exactTargetScore,
  candidateMatchesRequestedTarget,
  contentTokens as qmContentTokens,
  extractRequestedColumns,
  extractSerialNumber,
  rowSerialNumber,
} from "./query-match";

function tokenize(q: string): string[] {
  // Kept for callers that want quick content tokens; delegates to query-match
  // so we have a single source of truth for stopword handling.
  return qmContentTokens(q);
}

// Legacy STOP set retained only so any external importer keeps working; the
// authoritative stop-list now lives in ./query-match.
const STOP = new Set<string>();

function rowMatchesStrict(row: StoredRow, phrases: string[], tokens: string[], requestedColumns: string[] = []): number {
  const values = requestedColumns.length > 0 ? requestedColumns.map((col) => row.data[col]) : Object.values(row.data);
  const hay = normalizeHaystack(values);
  // When the user's query contains any strict phrase (proper noun, quoted
  // text, or 2+ content tokens), require EVERY phrase to appear as a
  // contiguous substring in the row, except code-like lookups may match all
  // tokens across columns (NBPDCL / NIT / 48 / Samastipur). This still stops
  // "Kunti Devi" from matching every "Devi" row.
  if (phrases.length > 0) {
    return exactTargetScore(hay, phrases, tokens);
  }
  if (tokens.length === 0) return 0;
  for (const t of tokens) if (!hay.includes(t)) return 0;
  return tokens.length;
}

function extractPhrases(q: string): string[] {
  return qmStrictPhrases(q);
}

function statusColumn(cols: string[]): string | null {
  return pickColumn(cols, [/^status$/i, /status/i, /stage/i, /state/i, /progress/i]);
}

function requestedFieldColumn(q: string, cols: string[]): string | null {
  const s = q.toLowerCase();
  const direct = cols.find((c) => {
    const normalizedColumn = c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return normalizedColumn.length >= 3 && new RegExp(`\\b${normalizedColumn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(s);
  });
  if (direct) return direct;
  if (/\b(phone|mobile|contact\s*(no|number)?|whats\s*app|whatsapp|tel(?:ephone)?)\b/.test(s)) {
    return pickColumn(cols, [/mobile/i, /phone/i, /whats\s*app|whatsapp/i, /contact.*(no|number)|contact$/i, /tel/i]);
  }
  if (/\b(email|e-mail|mail\s*id)\b/.test(s)) return pickColumn(cols, [/e-?mail/i, /mail\s*id/i]);
  if (/\b(status|stage|state|progress)\b/.test(s)) return statusColumn(cols);
  if (/\b(owner|responsible|assignee|assigned\s*to|person\s*responsible)\b/.test(s)) {
    return pickColumn(cols, [/responsible/i, /assignee/i, /assigned\s*to/i, /owner/i, /person/i]);
  }
  if (/\b(contractor|vendor|agency|supplier)\b/.test(s)) return pickColumn(cols, [/contractor/i, /vendor/i, /agency/i, /supplier/i]);
  if (/\b(due|deadline|eta|expiry|expires|validity|renewal|date)\b/.test(s)) {
    return pickColumn(cols, [/expiry|expires|expiration/i, /validity|valid\s*up/i, /renewal/i, /due/i, /deadline/i, /eta/i, /date/i]);
  }
  if (/\b(amount|value|balance|rate|price|cost|qty|quantity|total)\b/.test(s)) {
    return pickColumn(cols, [/amount/i, /value/i, /balance/i, /rate/i, /price|cost/i, /qty|quantity/i, /total/i]);
  }
  return null;
}

function positionalRowNumber(q: string): number | null {
  const match = /\b(?:row|line)\s*#?\s*(\d{1,6})\b/i.exec(q);
  if (!match || /\b(row\s*count|count\s*rows|how\s+many\s+rows)\b/i.test(q)) return null;
  return Number(match[1]);
}

function isTerminal(row: StoredRow, statusCol: string | null): boolean {
  if (!statusCol) return false;
  return TERMINAL.test(cellText(row.data[statusCol]));
}

function wantsActiveOnlyRows(q: string): boolean {
  const s = q.toLowerCase();
  const activeHit = /\b(active|open|pending|in\s*progress|ongoing|incomplete|not\s+completed|overdue|delayed|delay|late|breach|breached)\b/.test(s);
  if (!activeHit) return false;
  // Mixed-status questions ("delayed vs completed", "pending and closed",
  // "list open and done tasks") must not silently drop terminal rows.
  const terminalHit = /\b(complete[d]?|completion|done|closed|finished|resolved|delivered|dispatched|handover|handed\s+over|cancel(l)?ed)\b/.test(s);
  if (terminalHit) return false;
  return true;
}

type Intent =
  | { kind: "count" }
  | { kind: "sum" | "avg" | "min" | "max"; hint: string | null }
  | { kind: "top"; direction: "highest" | "lowest"; hint: string | null; n: number }
  | { kind: "distribution"; hint: string | null }
  | { kind: "list" }
  | { kind: "generic" };

function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  const numHint = /(amount|total|value|cost|price|qty|quantity|days|delay|score|balance|paid|revenue|budget)/i.exec(s)?.[1] ?? null;

  // Delegate to the verb lexicon (single source of truth). Falls back to the
  // legacy regexes only for the numeric-hint extraction and top-N number.
  const det = detectVerbIntent(q);
  const has = (i: string) => det.allMatches.some((m) => m.intent === i);

  if (has("count")) return { kind: "count" };
  if (has("distribution")) {
    const groupHint = /(status|stage|state|owner|type|priority|category|project|vendor|activity|region|department|uom|unit|store|location|branch|item|sku|product|material)/i.exec(s)?.[1] ?? null;
    return { kind: "distribution", hint: groupHint };
  }
  if (has("aggregate")) {
    if (/\b(average|avg|mean|median)\b/.test(s)) return { kind: "avg", hint: numHint };
    if (/\b(min|minimum|smallest|lowest\s+value)\b/.test(s)) return { kind: "min", hint: numHint };
    if (/\b(max|maximum|largest|highest\s+value)\b/.test(s)) return { kind: "max", hint: numHint };
    return { kind: "sum", hint: numHint };
  }
  if (has("top")) {
    const n = /\btop\s+(\d+)/.exec(s)?.[1];
    return { kind: "top", direction: "highest", hint: numHint, n: Number(n ?? 5) };
  }
  if (has("bottom")) {
    const n = /\bbottom\s+(\d+)/.exec(s)?.[1];
    return { kind: "top", direction: "lowest", hint: numHint, n: Number(n ?? 5) };
  }
  if (has("list") || has("lookup")) return { kind: "list" };
  return { kind: "generic" };
}

function scopeMentionRegex(scopeName: string): RegExp | null {
  const normalized = scopeName.trim().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (normalized.length < 3) return null;
  const escapedParts = normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escapedParts.length === 0) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapedParts.join("[^\\p{L}\\p{N}]+")}(?=$|[^\\p{L}\\p{N}])`, "giu");
}

// -------------------- main entry --------------------

// Detects "give me the insights / summary / overview / highlights / what's in
// this sheet / findings / anything I should know" questions. For these we
// short-circuit to the same Auto-Insights output the sheet header shows,
// so the Copilot answers from the *computed insights* — not from row-name
// token matching.
export function isInsightShapedQuery(q: string): boolean {
  const s = q.toLowerCase().trim();

  // Explain / why / discrepancy / variance / difference-between shapes are
  // computed-analysis asks — typically the Auto-Insights suggested questions
  // ("Explain the discrepancy between consumed_qty and planned_qty", "Why
  // is balance 2 or 3?", "What is the reason for the row with balance=10…").
  // These win over the row/record exclusion below so questions that phrase a
  // *filter condition* as "the row with X" still route to insight mode.
  const isExplainShape =
    /\b(explain|why|reason|cause|driver|drivers|root\s*cause)\b/.test(s)
    || /\b(discrepan|variance|mismatch|reconcil|gap\s+between|delta\s+between|difference\s+between)/.test(s)
    || /\bbetween\s+[\p{L}\p{N}_]+.{0,40}\band\s+[\p{L}\p{N}_]+/u.test(s);
  if (isExplainShape) return true;

  // Row/record/entity-specific asks are NOT insight-mode even when they
  // contain "summarize" / "highlights" / "snapshot" / "findings".
  if (/\b(row|record|entry|item|entity|profile)\b/.test(s)) return false;

  // Broad summary / overview / insights of sheet-wide nouns → insight mode.
  const broadInsightVerb = /\b(insight|insights|overview|highlights?|findings?|snapshot|health\s+check|what'?s\s+(in|inside|on)|what\s+(should|do)\s+i\s+know|anything\s+(interesting|notable|important)|key\s+(points?|takeaways?))\b/.test(s);
  const sheetWideNoun = /\b(sheet|data|dataset|table|source|sources|selection|selected|everything|all)\b/.test(s);
  const summarizeSheetWide = /\b(summary|summari[sz]e|tell\s+me\s+about|give\s+me\s+(an?\s+)?(overview|summary))\s+(of\s+)?(this|the|these|that|selected|all|entire|whole)?\s*(sheet|data|dataset|table|source|sources|selection)\b/.test(s);
  if (summarizeSheetWide) return true;
  if (broadInsightVerb && sheetWideNoun) return true;

  // Trailing "<preposition> <specific identifier>" is a targeted ask —
  // "highlights of samastipur", "snapshot of NIT-48", "details for X".
  // Only apply this escape when the tail is NOT a sheet-wide noun.
  if (/\b(?:for|of|about|on|regarding|around|re)\s+["'`]?[\p{L}\p{N}][\p{L}\p{N}_\-./ ]{1,}["'`]?\s*[?.!]*$/u.test(s)
      && !sheetWideNoun) return false;

  return false;
}

function extractTargetedRowTarget(q: string): string | null {
  const trimmed = q.trim();
  const rowish = /\b(row|record|entry|item|entity|profile|details?|full\s+record|highlights?|snapshot|findings?|takeaways?|notes?|status)\b/i.test(trimmed);
  const prepTail = /\b(?:for|of|about|on|regarding|around|re|named|called)\s+["'`]?[\p{L}\p{N}][\p{L}\p{N}_\-./ ]{1,}["'`]?\s*[?.!]*$/iu.test(trimmed);
  if (!rowish && !prepTail) return null;

  const patterns = [
    /\b(?:summari[sz]e|show|display|get|find|open|pull|give\s+me|tell\s+me\s+about)\b[\s\S]{0,80}?\b(?:row|record|entry|item|entity|profile|details?|full\s+record|highlights?|snapshot|findings?|takeaways?|notes?|status)\b[\s\S]{0,40}?\b(?:for|of|about|on|regarding|named|called)\s+(.+?)\s*[?.!]*$/iu,
    /\b(?:row|record|entry|item|entity|profile|details?|full\s+record|highlights?|snapshot|findings?|takeaways?|notes?|status)\b\s*(?:for|of|about|on|regarding|named|called)\s+(.+?)\s*[?.!]*$/iu,
    /\b(?:details?|full\s+record|highlights?|snapshot|findings?|takeaways?|status)\s+(?:for|of|about|on|regarding)\s+(.+?)\s*[?.!]*$/iu,
    /\b(?:for|about|regarding|named|called)\s+(.+?)\s*[?.!]*$/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const cleaned = raw
      .replace(/^['"`“”‘’]+|['"`“”‘’]+$/g, "")
      .replace(/\s+/g, " ")
      .replace(/[?.!,;:]+$/g, "")
      .trim();
    // Guard against catching common stopword tails like "for me", "about it".
    if (cleaned.length >= 2 && !/^(me|it|us|them|this|that|these|those|now|today|yesterday|tomorrow)$/i.test(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

/** Extract `col=value`, `col is value`, `where col = value` — the filter
 *  condition inside explain/why questions. */
function extractColumnValueFilter(q: string): { column: string; value: string } | null {
  const patterns: RegExp[] = [
    /['"`]?([A-Za-z][A-Za-z0-9_ ]{0,40}?)['"`]?\s*[=:]\s*['"`]?([A-Za-z0-9_.\-/]+)['"`]?/,
    /\b(?:where|with|for)\s+([A-Za-z][A-Za-z0-9_ ]{0,40}?)\s+(?:is|equals?|=)\s+['"`]?([A-Za-z0-9_.\-/]+)['"`]?/i,
    /\brow[s]?\s+(?:with|where|having)\s+([A-Za-z][A-Za-z0-9_ ]{0,40}?)\s+([0-9][A-Za-z0-9_.\-/]*)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(q);
    if (!m) continue;
    const column = m[1].trim().replace(/\s+/g, " ");
    const value = m[2].trim();
    if (column.length < 2 || value.length === 0) continue;
    if (/^(the|a|an|is|are|was|were|has|have|had|of|for|with|to|in|on|by|and|or|reason|why|what|which)$/i.test(column)) continue;
    return { column, value };
  }
  return null;
}

/** Find the actual column header that best matches a free-text token. */
function resolveColumnName(cols: string[], token: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const t = norm(token);
  if (!t) return null;
  const exact = cols.find((c) => norm(c) === t);
  if (exact) return exact;
  const contains = cols.find((c) => norm(c).includes(t) || t.includes(norm(c)));
  return contains ?? null;
}

/** Extract every `<column-token> <numeric-value>` pair from the query and
 *  resolve tokens against real sheet headers. Handles:
 *    "AC value of 440134.548"    → { column: AC, value: 440134.548 }
 *    "row uom 972"               → { column: uom, value: 972 }
 *    "balance = 10", "qty is 25" → { column: balance/qty, value: … }
 *  Used to catch precise verification/lookup asks the AI would otherwise
 *  loop on ("Is the AC value of X in row uom Y justified?"). */
function extractColumnValuePairs(
  q: string,
  cols: string[],
): Array<{ column: string; resolved: string; value: string }> {
  const out: Array<{ column: string; resolved: string; value: string }> = [];
  const seen = new Set<string>();
  const stop = /^(is|are|be|the|a|an|of|for|with|in|on|by|and|or|to|row|rows|record|value|values|number|no|nos|nit|next|last|past|top|only|any|all|has|have|had|was|were|does|do|did|justified|correct|right|accurate|reasonable|valid|match|verify|check|explain|why|reason|it|its|this|that|these|those|between|from|than|then|about|around|regarding|column|field|cell)$/i;
  const re = /\b([A-Za-z][A-Za-z0-9_]{0,30})\b(?:\s+(?:value|values|of|is|equals?|=|:))?\s+['"`]?([-+]?\d[\d,]*(?:\.\d+)?)['"`]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const tok = m[1];
    if (stop.test(tok)) continue;
    const resolved = resolveColumnName(cols, tok);
    if (!resolved) continue;
    const value = m[2].replace(/,/g, "");
    const key = `${resolved}=${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ column: tok, resolved, value });
  }
  return out;
}

/** Pull out concrete filter-like terms from a question: numbers with
 *  context, quoted phrases, and identifier-ish tokens (mix of letters and
 *  digits, or ALLCAPS). Used by the relevance guard to decide whether an
 *  Auto-Insights dump would actually address the question. */
function extractSpecificTerms(q: string): string[] {
  const out = new Set<string>();
  const stop = /^(the|a|an|is|are|was|were|of|for|with|to|in|on|by|and|or|why|what|which|reason|explain|between|from|than|this|that|it|its|all|any|row|rows|value|values|field|fields|number|numeric|zero|null|missing|blank|empty|next|last|past|days?|weeks?|months?|years?|top|only)$/i;
  const re = /['"`]([^'"`]{2,})['"`]|(\d[\d,.\-/]*)|([A-Z]{2,}[A-Za-z0-9_-]*)|([A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const t = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!t || t.length < 2 || stop.test(t)) continue;
    out.add(t);
  }
  return Array.from(out);
}




/** Configurable numeric equality. Two numbers are "equal" when they are within
 *  `absTol` OR within `relTol` (fraction) of the larger magnitude. Handles
 *  rounding, currency-symbol stripping, thousands separators, and trailing
 *  zeros. Returns match + absolute/relative delta for reporting. */
export type NumericTolerance = { abs: number; rel: number };
export const DEFAULT_NUMERIC_TOLERANCE: NumericTolerance = { abs: 0.01, rel: 0.0005 };

export function numericClose(
  a: number,
  b: number,
  tol: NumericTolerance = DEFAULT_NUMERIC_TOLERANCE,
): { match: boolean; absDelta: number; relDelta: number } {
  const absDelta = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  const relDelta = scale === 0 ? 0 : absDelta / scale;
  const match = absDelta <= tol.abs || relDelta <= tol.rel;
  return { match, absDelta, relDelta };
}

/** Parse a user-supplied tolerance from the query: "within 0.5", "±1",
 *  "tolerance 0.1", "tol=2%". Percent → relative tolerance; bare number →
 *  absolute. Returns undefined when the query specifies none. */
function parseTolerance(q: string): NumericTolerance | undefined {
  const pct = /(?:within|tolerance|tol|±|\+\/-|\+-)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*%/i.exec(q);
  if (pct) return { abs: 0, rel: Number(pct[1]) / 100 };
  const abs = /(?:within|tolerance|tol|±|\+\/-|\+-)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\b/i.exec(q);
  if (abs) return { abs: Number(abs[1]), rel: 0 };
  return undefined;
}

function compactRowFields(row: StoredRow, maxFields = 12): string {
  const entries = Object.entries(row.data)
    .map(([key, value]) => [key, cellText(value)] as const)
    .filter(([, value]) => value !== "");
  if (entries.length === 0) return "no non-empty fields";
  return entries
    .slice(0, maxFields)
    .map(([key, value]) => `${key}: ${value.slice(0, 100)}`)
    .join("; ");
}

export async function deterministicAnswer(params: {
  supabase: any;
  question: string;
  regs: SheetReg[];
  docs: DocMeta[];
  maxRowsPerSheet?: number;
  ledgerSink?: DeterministicLedgerEntry[];
  diagnosticsSink?: CopilotRetrievalDiagnostic[];
  /** When true: only contiguous full-phrase matches are returned. No token
   * AND fallback, no "recent rows" fallback, no surname-only leakage. */
  strictMatch?: boolean;
  /** Absolute + relative tolerance for numeric verification comparisons.
   *  Defaults to ±0.01 absolute / 0.05% relative. Overridden by any
   *  "within X" / "tolerance X" / "±X" phrase found in the question. */
  numericTolerance?: NumericTolerance;
}): Promise<{ answer: string; citations: string[]; matched: boolean }> {
  const { supabase, question, regs, docs } = params;
  const cap = params.maxRowsPerSheet ?? 200000;
  const strict = params.strictMatch === true;
  const activeOnly = wantsActiveOnlyRows(question);
  // Strip scope (sheet/doc) name substrings from the question BEFORE running
  // intent detection. Otherwise a sheet called "Stock Summary" hijacks any
  // question that mentions it — "Which contracts expire in the next 30 days
  // in stock summary?" would match `\bsummary\b` and short-circuit to
  // Auto-Insights instead of answering the temporal query.
  const scopeStripPatterns = [
    ...regs.map((r) => r.display_name),
    ...docs.map((d) => d.name),
  ]
    .filter((n) => n && n.trim().length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(scopeMentionRegex)
    .filter((re): re is RegExp => re != null);
  let questionForIntent = question;
  for (const re of scopeStripPatterns) questionForIntent = questionForIntent.replace(re, " ");
  const intent = detectIntent(questionForIntent);
  const insightMode = isInsightShapedQuery(questionForIntent);
  const rawTokens = tokenize(question);
  const rawPhrases = extractPhrases(question);
  const serialLookup = extractSerialNumber(question);
  const positionalRowLookup = positionalRowNumber(question);

  // Strip tokens/phrases that only match the selected sheet's OWN name
  // (or the selected document's name). Example: user picks a sheet called
  // "Stock Summary" and asks "summarize stock summary" — those tokens are
  // scope, not row-content filters. Without this we'd search every row for
  // the literal words "stock" / "summary" and return 0 matches even though
  // the sheet is full of relevant data.
  const normalizedQuestion = question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const scopeNames = [
    ...regs.map((r) => r.display_name),
    ...docs.map((d) => d.name),
  ].map((n) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());
  const mentionedScopeTokenSet = new Set<string>();
  for (const scopeName of scopeNames) {
    if (!scopeName || !new RegExp(`(^|\\s)${scopeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(normalizedQuestion)) continue;
    for (const token of scopeName.split(/\s+/)) mentionedScopeTokenSet.add(token);
  }
  const tokenIsOnlyScope = (t: string) =>
    mentionedScopeTokenSet.has(t) && scopeNames.some((n) => n.split(/\s+/).includes(t));
  const tokens = rawTokens.filter((t) => !tokenIsOnlyScope(t));
  const phraseIsOnlyScope = (p: string) => {
    const lc = p.toLowerCase().trim();
    return scopeNames.some((n) => n === lc || n.includes(lc));
  };
  const basePhrases = rawPhrases.filter((p) => !phraseIsOnlyScope(p));

  const cites: string[] = [];
  const parts: string[] = [];
  const recordDiagnostic = (diag: CopilotRetrievalDiagnostic) => {
    params.diagnosticsSink?.push(diag);
  };

  // Fast path for plain sheet-size questions. Do not fetch 50k+ rows just to
  // answer "how many rows are in this selected sheet?" — use registry metadata
  // and a sheet-level citation instead.
  const noRowCriteria = tokens.length === 0 && basePhrases.length === 0 && !activeOnly && !insightMode;
  if (intent.kind === "count" && noRowCriteria && regs.length > 0) {
    const countParts: string[] = [];
    for (const reg of regs) {
      const marker = `[sheet:${reg.display_name}]`;
      cites.push(marker);
      countParts.push(`**${reg.display_name}** — ${fmt(reg.row_count ?? 0)} total rows. ${marker}`);
    }
    const uniq = Array.from(new Set(cites));
    return {
      answer: countParts.join("\n") + `\n\nSources:\n${uniq.map((m) => `- ${m}`).join("\n")}`,
      citations: uniq,
      matched: true,
    };
  }

  // Load rows for every scoped sheet in parallel.
  const sheetRows = await Promise.all(
    regs.map(async (r) => {
      const rows = await fetchRows(supabase, r.id, cap);
      return { reg: r, rows };
    }),
  );
  // Multi-pair value verification gate — catches "Is the <col> value of <n>
  // in row <col2> <n2> justified?" and similar precise lookups the AI would
  // otherwise loop on until the model timeout fires. Only runs when the query
  // is NOT insight-shaped (explain/why routes to the insight gate below).
  // Uses configurable numeric tolerance (default ±0.01 abs / 0.05% rel) so
  // rounding and formatting differences still justify near-equal values;
  // "within X" / "tolerance X" / "±X" in the question overrides the default.
  const tol: NumericTolerance =
    parseTolerance(question) ?? params.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  // Universal filter-conditioned lookup — runs for EVERY query (insight or
  // not). If the question mentions any real column with a value, filter to
  // matching rows and answer from those. This is the choke-point that kills
  // the recurring "meaningless Auto-Insights dump" problem.
  {
    const allColsUnion = Array.from(new Set(sheetRows.flatMap(({ rows }) => allColumns(rows))));
    const pairs = extractColumnValuePairs(question, allColsUnion);
    if (pairs.length >= 1) {
      const filterCites: string[] = [];
      const filterParts: string[] = [];
      let totalMatched = 0;
      let totalNear = 0;
      const compareCell = (
        cellRaw: unknown,
        wantRaw: string,
      ): { ok: boolean; near: boolean; absDelta: number; relDelta: number; cellNum: number | null } => {
        const cellNum = parseNum(cellRaw);
        const wantNum = parseNum(wantRaw);
        if (cellNum !== null && wantNum !== null) {
          const cmp = numericClose(cellNum, wantNum, tol);
          return { ok: cmp.match, near: cmp.match && cmp.absDelta > 0, absDelta: cmp.absDelta, relDelta: cmp.relDelta, cellNum };
        }
        return { ok: cellText(cellRaw).toLowerCase() === wantRaw.toLowerCase(), near: false, absDelta: 0, relDelta: 0, cellNum: null };
      };
      for (const { reg, rows } of sheetRows) {
        if (rows.length === 0) continue;
        const cols = allColumns(rows);
        const applicable = pairs.filter((p) => cols.includes(p.resolved));
        if (applicable.length === 0) continue;
        const matches = rows.filter((r) => applicable.every((p) => compareCell(r.data[p.resolved], p.value).ok));
        if (matches.length === 0) continue;
        totalMatched += matches.length;
        const numericCols = cols.filter((c) => rows.slice(0, 200).some((r) => parseNum(r.data[c]) !== null));
        const conds = applicable.map((p) => `\`${p.resolved}\` = ${p.value}`).join(" AND ");
        const shown = matches.slice(0, 10);
        filterParts.push(
          `**${reg.display_name}** — ${fmt(matches.length)} row${matches.length === 1 ? "" : "s"} where ${conds}:`,
        );
        for (const row of shown) {
          const marker = `[sheet:${reg.display_name} row ${row.row_index}]`;
          filterCites.push(marker);
          const deltaNotes: string[] = [];
          for (const p of applicable) {
            const cmp = compareCell(row.data[p.resolved], p.value);
            if (cmp.cellNum !== null && cmp.absDelta > 0) {
              totalNear += 1;
              deltaNotes.push(`\`${p.resolved}\`: cell=${fmt(cmp.cellNum)} vs asked=${p.value} (Δ ${cmp.absDelta.toFixed(4)})`);
            }
          }
          const zeroCols = numericCols.filter((c) => parseNum(row.data[c]) === 0);
          const nonZeroCols = numericCols.filter((c) => {
            const n = parseNum(row.data[c]);
            return n !== null && n !== 0;
          });
          const zeroNote = zeroCols.length > 0 ? ` Zero-valued: ${zeroCols.slice(0, 6).map((c) => `\`${c}\``).join(", ")}.` : "";
          const nonZeroNote = nonZeroCols.length > 0 ? ` Non-zero: ${nonZeroCols.slice(0, 6).map((c) => `\`${c}\`=${fmt(parseNum(row.data[c])!)}`).join(", ")}.` : "";
          const dNote = deltaNotes.length ? ` — near-match: ${deltaNotes.join("; ")}` : "";
          filterParts.push(`- Row ${row.row_index}: ${compactRowFields(row, 10)}.${zeroNote}${nonZeroNote}${dNote} ${marker}`);
          params.ledgerSink?.push({
            kind: "sheet_row", registryId: reg.id, sheetLabel: reg.display_name, rowIndex: row.row_index, data: row.data,
          });
        }
        if (matches.length > shown.length) {
          filterParts.push(`- …and ${fmt(matches.length - shown.length)} more matching row${matches.length - shown.length === 1 ? "" : "s"}.`);
        }
      }
      if (totalMatched > 0) {
        const uniq = Array.from(new Set(filterCites));
        const summary = pairs.map((p) => `\`${p.resolved}\` = ${p.value}`).join(" AND ");
        const verdict = insightMode
          ? `The dashboard sheets don't store a separate "reason" column for these values, so the ground truth is the matched rows themselves and which of their numeric fields are zero vs non-zero.`
          : (totalNear === 0
              ? `Exactly justified — all matched cells equal the asked values.`
              : `Justified within tolerance ±${tol.abs} — ${totalNear} field${totalNear === 1 ? "" : "s"} match via rounding tolerance.`);
        return {
          answer:
            `Filtered the selected sheet(s) to rows where ${summary}. ${verdict}\n\n` +
            filterParts.join("\n") +
            `\n\nSources:\n${uniq.map((m) => `- ${m}`).join("\n")}`,
          citations: uniq,
          matched: true,
        };
      }
      // Pairs extracted but no row matches. For 2+ pairs (precise
      // verification) return early. For a single pair, still honest-refuse
      // rather than let the query slide into a sheet-wide Auto-Insights dump.
      const scopeMarkers = regs.map((r) => `[sheet:${r.display_name}]`);
      const summary = pairs.map((p) => `\`${p.resolved}\` = ${p.value}`).join(" AND ");
      return {
        answer:
          `No rows in the selected sheet(s) satisfy ${summary}. ` +
          `I did not fall back to sheet-wide Auto-Insights because your question is scoped to a specific filter — the honest answer is that the condition doesn't match any row.\n\nSources:\n${scopeMarkers.map((m) => `- ${m}`).join("\n")}`,
        citations: scopeMarkers,
        matched: true,
      };
    }
  }


  // Targeted row/record asks must never fall through to sheet-wide
  // Auto-Insights. This handles prompts generated by Auto-Insights itself,
  // e.g. “Summarize the row for Punjab_Kharar_Store.”
  // BUT: explain/why/reason/discrepancy questions (insightMode) are
  // computed-analysis asks — even when phrased as "the row with balance=10",
  // the tail is a *filter condition*, not a row identifier. Skip targeted
  // lookup so we don't hijack them into a literal name search.
  const targetedRowTarget = insightMode
    ? null
    : (extractTargetedRowTarget(questionForIntent) ?? extractTargetedRowTarget(question));
  if (targetedRowTarget) {
    const targetTokens = qmContentTokens(targetedRowTarget);
    const targetPhrases = qmStrictPhrases(targetedRowTarget);
    const matchedRows: Array<{ reg: SheetReg; row: StoredRow; score: number; label: string }> = [];
    const suggestionRows: Array<{ reg: SheetReg; row: StoredRow; score: number; label: string }> = [];

    for (const { reg, rows } of sheetRows) {
      const cols = allColumns(rows);
      for (const row of rows) {
        const texts = Object.values(row.data).map((value) => cellText(value)).filter(Boolean);
        const hay = normalizeHaystack(texts);
        const exactCell = texts.find((text) => candidateMatchesRequestedTarget(text, targetPhrases, targetTokens));
        const exactRow = targetPhrases.length > 0
          ? matchesExactTarget(hay, targetPhrases, targetTokens)
          : targetTokens.length > 0 && targetTokens.every((token) => hay.includes(token));
        const allTokenHit = targetTokens.length >= 2 && targetTokens.every((token) => hay.includes(token));
        const hitCount = targetTokens.filter((token) => hay.includes(token)).length;
        const label = exactCell ?? texts.find((text) => /[\p{L}\p{N}]/u.test(text)) ?? `row ${row.row_index + 1}`;

        if (exactCell || exactRow || allTokenHit) {
          matchedRows.push({ reg, row, score: exactCell ? 100 : exactRow ? 80 : 60 + hitCount, label });
        } else if (hitCount > 0) {
          suggestionRows.push({ reg, row, score: hitCount, label });
        }
      }
      recordDiagnostic({
        sourceId: reg.id,
        sourceName: reg.display_name,
        sourceType: "sheet",
        matcherPath: "targeted_row_lookup",
        rowsScanned: rows.length,
        rowsMatched: matchedRows.filter((match) => match.reg.id === reg.id).length,
        columnsSearched: cols,
      });
    }

    const uniqueByRow = <T extends { reg: SheetReg; row: StoredRow }>(items: T[]) => {
      const seenRows = new Set<string>();
      const out: T[] = [];
      for (const item of items.sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))) {
        const key = `${item.reg.id}:${item.row.row_index}`;
        if (seenRows.has(key)) continue;
        seenRows.add(key);
        out.push(item);
      }
      return out;
    };

    const exactMatches = uniqueByRow(matchedRows).slice(0, 5);
    if (exactMatches.length > 0) {
      const lines: string[] = [];
      const rowCites: string[] = [];
      for (const match of exactMatches) {
        const marker = `[sheet:${match.reg.display_name} row ${match.row.row_index + 1}]`;
        rowCites.push(marker);
        params.ledgerSink?.push({
          kind: "sheet_row",
          registryId: match.reg.id,
          sheetLabel: match.reg.display_name,
          rowIndex: match.row.row_index,
          data: match.row.data,
        });
        lines.push(`- **${match.label.slice(0, 100)}** — ${compactRowFields(match.row)} ${marker}`);
      }
      const uniqRowCites = Array.from(new Set(rowCites));
      return {
        answer:
          `Found the requested row for **${targetedRowTarget}** in the selected sheet${exactMatches.length === 1 ? "" : "s"}:

${lines.join("\n")}

Sources:
${uniqRowCites.map((marker) => `- ${marker}`).join("\n")}`,
        citations: uniqRowCites,
        matched: true,
      };
    }

    const close = uniqueByRow(suggestionRows).slice(0, 5);
    const scopeMarkers = regs.map((r) => `[sheet:${r.display_name}]`);
    if (close.length > 0) {
      const lines: string[] = [];
      const closeCites: string[] = [];
      for (const match of close) {
        const marker = `[sheet:${match.reg.display_name} row ${match.row.row_index + 1}]`;
        closeCites.push(marker);
        params.ledgerSink?.push({
          kind: "sheet_row",
          registryId: match.reg.id,
          sheetLabel: match.reg.display_name,
          rowIndex: match.row.row_index,
          data: match.row.data,
        });
        lines.push(`- ${match.label.slice(0, 100)} ${marker}`);
      }
      const uniqCloseCites = Array.from(new Set(closeCites));
      return {
        answer:
          `No exact row match for **${targetedRowTarget}** in the selected sheets. I did not return Auto-Insights because this is a row-specific request. Closest candidates:

${lines.join("\n")}

Sources:
${uniqCloseCites.map((marker) => `- ${marker}`).join("\n")}`,
        citations: uniqCloseCites,
        matched: true,
      };
    }

    return {
      answer:
        `No exact row match for **${targetedRowTarget}** in the selected sheets. I did not return Auto-Insights because this is a row-specific request. ${scopeMarkers[0] ?? ""}

Sources:
${scopeMarkers.map((marker) => `- ${marker}`).join("\n")}`,
      citations: scopeMarkers,
      matched: true,
    };
  }

  // Lazy-import Auto-Insights so we share the same computation the sheet
  // header uses. This is the bridge that connects Copilot answers to the
  // active-sheet Auto-Insights outputs.
  const { buildSheetAutoInsights, detectSheetShape } = await import(
    "./auto-insights-fallback.server"
  );

  const emitInsightBlock = (reg: SheetReg, rows: StoredRow[]) => {
    if (rows.length === 0) return;
    const cols = allColumns(rows);
    const shape = detectSheetShape(cols);
    const { insights, questions } = buildSheetAutoInsights(
      reg.display_name,
      rows.map((r) => ({ row_index: r.row_index, data: r.data })),
    );
    if (insights.length === 0) return;
    const marker = `[sheet:${reg.display_name}]`;
    cites.push(marker);
    parts.push(
      `**${reg.display_name}** — Auto-Insights (detected shape: \`${shape}\`, ${fmt(rows.length)} rows scanned):`,
    );
    for (const ins of insights.slice(0, 6)) {
      const sev = ins.severity === "critical" ? "🔴" : ins.severity === "warning" ? "🟡" : "•";
      parts.push(`- ${sev} **${ins.title}** — ${ins.detail} ${marker}`);
    }
    if (questions.length) {
      parts.push(
        `_Suggested follow-ups:_ ${questions.slice(0, 3).map((q) => `“${q}”`).join(" · ")}`,
      );
    }
  };

  // Insight-shaped questions → try filter-conditioned lookup FIRST
  // ("reason for the row with balance=10 having zero values" is not a
  // request for sheet-wide auto-insights; it wants the rows where
  // balance=10 and an explanation of their zero fields). If we can extract
  // a `<col> <op> <val>` filter, resolve it against the sheet columns and
  // emit those exact rows. Only fall back to Auto-Insights when no filter
  // is present or the filter matches nothing.
  if (insightMode) {
    // (Universal filter-conditioned lookup already ran above and returned
    // early on any resolvable `<col> <value>` — we only get here for
    // genuinely sheet-wide explain/why questions like "why so many overdue?".)

    // Answer Relevance Guard: if the question contains specific concrete
    // tokens (numbers, IDs) that Auto-Insights won't reference, refuse
    // honestly instead of dumping a generic insight block.
    const specificTerms = extractSpecificTerms(question);
    if (specificTerms.length > 0) {
      const scopeMarkers = regs.map((r) => `[sheet:${r.display_name}]`);
      return {
        answer:
          `Your question mentions specific terms (${specificTerms.slice(0, 6).map((t) => `\`${t}\``).join(", ")}) that I could not resolve against any column or value in the selected sheet(s). ` +
          `I'm not returning sheet-wide Auto-Insights because those wouldn't address your specific filter. ` +
          `Please check the term spelling, or ask a broader "why / overview" question if you want the computed insights.\n\nSources:\n${scopeMarkers.map((m) => `- ${m}`).join("\n")}`,
        citations: scopeMarkers,
        matched: true,
      };
    }

    for (const { reg, rows } of sheetRows) emitInsightBlock(reg, rows);
    if (parts.length > 0) {
      const uniqCites = Array.from(new Set(cites));
      return {
        answer:
          `Answered from the computed Auto-Insights of the selected sheet(s):\n\n` +
          parts.join("\n") +
          `\n\nSources:\n${uniqCites.map((m) => `- ${m}`).join("\n")}`,
        citations: uniqCites,
        matched: true,
      };
    }
  }


  // In strict mode, if the query has no explicit phrase, treat the full
  // content-token phrase as required — so a single-word query still needs
  // a contiguous match of that word.
  const phrases = strict && basePhrases.length === 0 && tokens.length >= 1
    ? [tokens.join(" ")]
    : basePhrases;

  for (const { reg, rows } of sheetRows) {
    if (rows.length === 0) continue;
    const cols = allColumns(rows);
    const statusCol = statusColumn(cols);
    const activeRows = rows.filter((r) => !isTerminal(r, statusCol));
    const searchRows = activeOnly ? activeRows : rows;
    const requestedColumns = extractRequestedColumns(question, cols);
    const requestedColumnNorms = new Set(requestedColumns.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
    const searchPhrases = phrases.filter((p) => !requestedColumnNorms.has(p));
    const hasCriteria = tokens.length > 0 || phrases.length > 0;
    let matched = (tokens.length > 0 || phrases.length > 0)
      ? searchRows
          // Always pass tokens, even in strict mode. `matchesExactTarget` uses
          // them to permit identifier lookups split across columns (for example
          // NBPDCL / NIT 48 / Samastipur) while still requiring contiguous
          // natural-language names such as Kunti Devi.
          .map((row) => ({ row, score: rowMatchesStrict(row, searchPhrases, tokens, requestedColumns) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.row)
      : searchRows;
    if (serialLookup !== null) {
      const serialMatches = searchRows.filter((row) => rowSerialNumber(row.data) === String(serialLookup));
      if (serialMatches.length > 0) matched = serialMatches;
    }
    if (positionalRowLookup !== null) {
      const rowHit = rows.find((row) => row.row_index === positionalRowLookup - 1);
      matched = rowHit ? [rowHit] : [];
    }
    const matcherPath = insightMode
      ? "auto_insights"
      : activeOnly
        ? "deterministic_active_filter"
        : requestedColumns.length > 0
          ? "deterministic_column_exact"
          : searchPhrases.length > 0
            ? "deterministic_phrase_exact"
            : tokens.length > 0
              ? "deterministic_token_exact"
              : "deterministic_all_rows";
    recordDiagnostic({
      sourceId: reg.id,
      sourceName: reg.display_name,
      sourceType: "sheet",
      matcherPath,
      rowsScanned: searchRows.length,
      rowsMatched: matched.length,
      columnsSearched: requestedColumns.length ? requestedColumns : cols,
    });
    // In strict mode we NEVER broaden. Otherwise, if the user targeted a
    // specific phrase/name and nothing matches, we still return empty so
    // unrelated rows never leak.
    const hasSpecificTarget = searchPhrases.length > 0 || tokens.length >= 2;
    const universe = matched.length > 0
      ? matched
      : strict
        ? []
        : (hasSpecificTarget ? [] : searchRows);

    const emitRow = (row: StoredRow, note?: string) => {
      const marker = `[sheet:${reg.display_name} row ${row.row_index + 1}]`;
      cites.push(marker);
      params.ledgerSink?.push({
        kind: "sheet_row",
        registryId: reg.id,
        sheetLabel: reg.display_name,
        rowIndex: row.row_index,
        data: row.data,
      });
      const preview = Object.entries(row.data)
        .filter(([, v]) => cellText(v) !== "")
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${cellText(v).slice(0, 60)}`)
        .join(" · ");
      return `- ${note ? `${note} — ` : ""}${preview} ${marker}`;
    };

    const fieldCol = requestedFieldColumn(question, cols);
    if (fieldCol && universe.length > 0 && (hasCriteria || serialLookup !== null || positionalRowLookup !== null)) {
      parts.push(`**${reg.display_name}** — exact \`${fieldCol}\` value${universe.length === 1 ? "" : "s"}:`);
      for (const row of universe.slice(0, 10)) {
        const marker = `[sheet:${reg.display_name} row ${row.row_index + 1} col ${fieldCol}]`;
        cites.push(marker);
        params.ledgerSink?.push({
          kind: "sheet_row",
          registryId: reg.id,
          sheetLabel: reg.display_name,
          rowIndex: row.row_index,
          data: row.data,
        });
        const identifier = Object.entries(row.data)
          .filter(([key, value]) => key !== fieldCol && cellText(value) !== "")
          .slice(0, 2)
          .map(([key, value]) => `${key}: ${cellText(value).slice(0, 50)}`)
          .join(" · ");
        parts.push(`- ${identifier ? `${identifier} — ` : ""}${fieldCol}: **${cellText(row.data[fieldCol]) || "(blank)"}** ${marker}`);
      }
      continue;
    }

    if (intent.kind === "count") {
      const count = hasCriteria ? matched.length : searchRows.length;
      const denominatorLabel = activeOnly ? "active" : "total";
      const columnNote = requestedColumns.length ? ` in column(s): ${requestedColumns.map((c) => `\`${c}\``).join(", ")}` : "";
      const sheetMarker = `[sheet:${reg.display_name}]`;
      cites.push(sheetMarker);
      parts.push(
        `**${reg.display_name}** — ${fmt(count)} matching rows${columnNote}${hasCriteria ? ` (of ${fmt(searchRows.length)} ${denominatorLabel})` : ""}. ${sheetMarker}`,
      );
      for (const r of universe.slice(0, 3)) parts.push(emitRow(r));
      continue;
    }

    if (intent.kind === "sum" || intent.kind === "avg" || intent.kind === "min" || intent.kind === "max") {
      const pick = pickNumericColumn(universe, cols, intent.hint);
      if (!pick) {
        parts.push(`**${reg.display_name}** — no numeric column detected for ${intent.kind}.`);
        continue;
      }
      const values = pick.values.map((v) => v.n);
      let value = 0;
      let extremeRow: StoredRow | null = null;
      if (intent.kind === "sum") value = values.reduce((a, b) => a + b, 0);
      else if (intent.kind === "avg") value = values.reduce((a, b) => a + b, 0) / values.length;
      else if (intent.kind === "min") {
        const found = pick.values.reduce((a, b) => (b.n < a.n ? b : a));
        value = found.n;
        extremeRow = found.row;
      } else if (intent.kind === "max") {
        const found = pick.values.reduce((a, b) => (b.n > a.n ? b : a));
        value = found.n;
        extremeRow = found.row;
      }
      parts.push(`**${reg.display_name}** — ${intent.kind} of \`${pick.column}\` = **${fmt(value)}** across ${fmt(values.length)} rows.`);
      if (extremeRow) parts.push(emitRow(extremeRow, `${intent.kind} row`));
      else for (const r of universe.slice(0, 2)) parts.push(emitRow(r));
      continue;
    }

    if (intent.kind === "top") {
      const pick = pickNumericColumn(universe, cols, intent.hint);
      if (!pick) {
        parts.push(`**${reg.display_name}** — no numeric column detected for a top-N ranking.`);
        continue;
      }
      const sorted = [...pick.values].sort((a, b) => (intent.direction === "highest" ? b.n - a.n : a.n - b.n));
      parts.push(`**${reg.display_name}** — ${intent.direction === "highest" ? "top" : "bottom"} ${Math.min(intent.n, sorted.length)} by \`${pick.column}\`:`);
      for (const { row, n } of sorted.slice(0, intent.n)) parts.push(emitRow(row, `${pick.column} = ${fmt(n)}`));
      continue;
    }

    if (intent.kind === "distribution") {
      // Try to resolve the group-by column directly from the user's query
      // words against real sheet columns. This handles "break down stock uom",
      // "breakdown by store name", "distribution of UOM", etc. — where the
      // group column is named in the question but not matched by generic hints.
      const normCol = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const qnorm = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const qTokens = new Set(qnorm.split(/\s+/).filter((t) => t.length >= 2));
      const colFromQuery = cols
        .map((c) => {
          const n = normCol(c);
          if (!n) return { c, score: 0 };
          if (qnorm.includes(n) && n.length >= 3) return { c, score: 100 + n.length };
          const parts = n.split(/\s+/).filter((p) => p.length >= 2);
          const hits = parts.filter((p) => qTokens.has(p)).length;
          return { c, score: parts.length > 0 && hits === parts.length ? 50 + hits : hits };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.c;
      const groupCol =
        colFromQuery ||
        (intent.hint && cols.find((c) => new RegExp(intent.hint!, "i").test(c))) ||
        statusCol ||
        pickColumn(cols, [/type/i, /category/i, /priority/i, /owner/i, /project/i, /vendor/i, /activity/i]);
      if (!groupCol) {
        parts.push(`**${reg.display_name}** — no group-by column detected.`);
        continue;
      }
      // For a group-by, the "universe" is the whole sheet (or activeRows) —
      // do NOT filter by phrase matches when the phrase is the group column.
      const distUniverse = universe.length > 0 ? universe : searchRows;

      const counts = new Map<string, StoredRow[]>();
      for (const r of distUniverse) {
        const key = cellText(r.data[groupCol]) || "(blank)";
        if (!counts.has(key)) counts.set(key, []);
        counts.get(key)!.push(r);
      }
      const entries = Array.from(counts.entries()).sort((a, b) => b[1].length - a[1].length);
      parts.push(`**${reg.display_name}** — distribution by \`${groupCol}\`:`);
      for (const [key, rs] of entries.slice(0, 10)) {
        const sample = rs[0];
        parts.push(`- ${key}: ${fmt(rs.length)} ${emitRowInline(sample, reg, cites, params.ledgerSink)}`);
      }
      continue;
    }

    // list / generic — return top matches
    const previewCount = intent.kind === "list" ? 10 : 6;
    if (universe.length === 0) {
      parts.push(`**${reg.display_name}** — 0 matching rows.`);
      continue;
    }
    parts.push(`**${reg.display_name}** — showing ${Math.min(previewCount, universe.length)} of ${fmt(universe.length)} matching rows:`);
    for (const r of universe.slice(0, previewCount)) parts.push(emitRow(r));
  }

  // Documents: keyword-hit snippets by page.
  if (docs.length > 0) {
    const { fetchAllDocumentChunks } = await import("./copilot-helpers.server");
    const chunks = await fetchAllDocumentChunks(supabase, docs.map((d) => d.id));
    const grouped = new Map<string, DocChunk[]>();
    for (const c of (chunks ?? []) as DocChunk[]) {
      const key = c.document_id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(c);
    }
    for (const d of docs) {
      const list = grouped.get(d.id) ?? [];
      const scored = tokens.length > 0
        ? list
            .map((c) => {
              const text = (c.content ?? "").toLowerCase();
              let s = 0;
              for (const t of tokens) if (text.includes(t)) s += 1;
              return { c, s };
            })
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 4)
        : list.slice(0, 4).map((c) => ({ c, s: 1 }));
      recordDiagnostic({
        sourceId: d.id,
        sourceName: d.name,
        sourceType: "document",
        matcherPath: tokens.length > 0 ? "document_full_chunk_keyword" : "document_full_chunk_sample",
        rowsScanned: list.length,
        rowsMatched: scored.length,
      });
      if (scored.length === 0) continue;
      parts.push(`**${d.name}** — ${scored.length} relevant excerpt${scored.length === 1 ? "" : "s"}:`);
      for (const { c } of scored) {
        const page = c.page_no ?? 1;
        const snippet = (c.content ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
        const marker = `[doc:${d.name} p.${page}]`;
        cites.push(marker);
        params.ledgerSink?.push({
          kind: "doc_chunk",
          documentId: d.id,
          documentName: d.name,
          pageNo: page,
          snippet,
        });
        parts.push(`- "${snippet}…" ${marker}`);
      }
    }
  }

  const uniqCites = Array.from(new Set(cites));

  // If we produced no cited findings, emit the canonical refusal instead of an
  // uncited "0 rows" summary — the client-side citation validator rejects any
  // answer that has no inline [..] markers, which turned into a bogus
  // "Answer rejected — grounding check failed" for the user.
  if (parts.length === 0 || uniqCites.length === 0) {
    // EXACT-MATCH GUARDRAIL: when the user asked for something specific
    // (proper noun, quoted phrase, identifier like IT76/#123, or 2+
    // content tokens) and we found NO exact match, never fall back to
    // Auto-Insights or generic refusal — surface closest candidates and
    // ask a clarifying question. This prevents returning IT77 when the
    // user asked for IT76, or Ram Devi when they asked for Kunti Devi.
    // Drop phrases that merely name a column of a selected sheet — they are
    // meta-references ("Store Name", "TAT"), not value lookups. Without this
    // the guardrail treats questions ABOUT a column as a failed value search.
    const allSheetColumnNorms = new Set<string>();
    for (const { rows } of sheetRows) {
      for (const c of allColumns(rows)) {
        allSheetColumnNorms.add(c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
      }
    }
    const targetPhrases = basePhrases.filter(
      (p) => !allSheetColumnNorms.has(p.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
    );
    const hadSpecificTarget = targetPhrases.length > 0;
    if (hadSpecificTarget) {
      const suggestions: string[] = [];
      const suggestCites: string[] = [];
      const seen = new Set<string>();
      const seenSuggestionLabels = new Set<string>();
      const exactRescueLines: string[] = [];
      const exactRescueCites: string[] = [];
      for (const { reg, rows } of sheetRows) {
        const cols = allColumns(rows);
        const statusCol = statusColumn(cols);
        const searchRows = activeOnly ? rows.filter((r) => !isTerminal(r, statusCol)) : rows;
        const requestedColumns = extractRequestedColumns(question, cols);
        const requestedColumnNorms = new Set(requestedColumns.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
        const scoredPhrases = targetPhrases.filter((p) => !requestedColumnNorms.has(p));
        const scored = searchRows
          .map((r) => {
            const values = requestedColumns.length > 0 ? requestedColumns.map((col) => r.data[col]) : Object.values(r.data);
            const hay = normalizeHaystack(values);
            let s = 0;
            for (const t of scoredPhrases.flatMap((p) => p.split(" ").filter((x) => x.length >= 2))) if (hay.includes(t)) s++;
            return { r, s };
          })
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, 3);
        for (const { r } of scored) {
          // Pick a useful label from the cells that actually overlap the
          // user's target. Avoid unit/header-like values such as "Nos".
          const targetTokens = scoredPhrases.flatMap((p) => p.split(" ").filter((x) => x.length >= 2));
          const genericCell = /^(nos?|n\/a|na|nil|none|yes|no|unit|qty|quantity|blank|0)$/i;
          const texts = Object.values(r.data)
            .map((v) => cellText(v))
            .filter((v) => v.length > 0 && !genericCell.test(v.trim()));
          const ranked = texts
            .map((v) => {
              const h = normalizeHaystack([v]);
              const tokenHits = targetTokens.filter((t) => h.includes(t)).length;
              const phraseHits = scoredPhrases.filter((p) => matchesExactTarget(h, [p], p.split(" "))).length;
              return { v, score: phraseHits * 10 + tokenHits * 2 + Math.min(v.length, 80) / 80 };
            })
            .filter((x) => /[a-zA-Z]/.test(x.v) && x.v.length >= 4)
            .sort((a, b) => b.score - a.score);
          const label = ranked[0]?.v ?? texts.find((v) => /[a-zA-Z]/.test(v) && v.length >= 4) ?? `row ${r.row_index + 1}`;
          const key = `${reg.id}#${r.row_index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const marker = `[sheet:${reg.display_name} row ${r.row_index + 1}]`;
          const preview = Object.entries(r.data)
            .filter(([, v]) => cellText(v) !== "")
            .slice(0, 6)
            .map(([k, v]) => `${k}: ${cellText(v).slice(0, 80)}`)
            .join(" · ");
          // Exact-match rescue is fully case-insensitive and
          // separator-normalized: check the chosen label AND every other
          // cell in the row. If ANY cell in this row equals the requested
          // target after case/punctuation normalization, treat it as an
          // exact hit — not a "did you mean" suggestion. This prevents
          // self-contradictory clarifications when the matching value
          // lives in an identifier cell that wasn't picked as the label.
          const cellMatchesTarget = (v: string) =>
            candidateMatchesRequestedTarget(v, targetPhrases, tokens);
          const matchedCell = cellMatchesTarget(label)
            ? label
            : texts.find(cellMatchesTarget);
          if (matchedCell) {
            exactRescueLines.push(`- ${preview || matchedCell} ${marker}`);
            exactRescueCites.push(marker);
          } else {
            const labelKey = normalizeHaystack([label]);
            if (!seenSuggestionLabels.has(labelKey)) {
              seenSuggestionLabels.add(labelKey);
              suggestions.push(`\`${label.slice(0, 80)}\` ${marker}`);
              suggestCites.push(marker);
            }
          }
          params.ledgerSink?.push({
            kind: "sheet_row",
            registryId: reg.id,
            sheetLabel: reg.display_name,
            rowIndex: r.row_index,
            data: r.data,
          });
        }
      }
      const asked = targetPhrases[0] ?? tokens.join(" ");
      if (exactRescueLines.length > 0) {
        const uniqExactCites = Array.from(new Set(exactRescueCites));
        return {
          answer:
            `Found exact separator-normalized match for "${asked}" in the selected sources:\n\n` +
            exactRescueLines.slice(0, 10).join("\n") +
            `\n\nSources:\n${uniqExactCites.map((m) => `- ${m}`).join("\n")}`,
          citations: uniqExactCites,
          matched: true,
        };
      }
      if (suggestions.length > 0) {
        const answer =
          `**No exact match for "${asked}"** in the selected sources.\n\n` +
          `I refuse to return a similar-but-different record. Did you mean one of these?\n\n` +
          suggestions.slice(0, 5).map((s) => `- ${s}`).join("\n") +
          `\n\nReply with the exact identifier/name from the list, or refine your query.\n\n` +
          `Sources:\n${suggestCites.slice(0, 5).map((m) => `- ${m}`).join("\n")}`;
        return { answer, citations: suggestCites.slice(0, 5), matched: false };
      }
      const scopeMarkers = [
        ...regs.map((r) => `[sheet:${r.display_name}]`),
        ...docs.map((d) => `[doc:${d.name}]`),
      ];
      const answer =
        `**No exact match for "${asked}"** in the selected sources, and I found no close candidates either. ` +
        `Please double-check the spelling / identifier, or pick a different sheet or document from the source picker. ${scopeMarkers[0] ?? ""}` +
        `\n\nSources:\n${scopeMarkers.map((m) => `- ${m}`).join("\n")}`;
      return { answer, citations: scopeMarkers, matched: false };
    }

    // Before refusing, fall back to the computed Auto-Insights for the
    // scoped sheet(s). If Auto-Insights can say something useful about
    // the selected data, we should too — the user has explicitly picked
    // this sheet as scope.
    if (!strict) {
      for (const { reg, rows } of sheetRows) emitInsightBlock(reg, rows);
      const uniq2 = Array.from(new Set(cites));
      if (parts.length > 0 && uniq2.length > 0) {
        return {
          answer:
            `No direct row match, but here is what the computed Auto-Insights say about the selected sheet(s):\n\n` +
            parts.join("\n") +
            `\n\nSources:\n${uniq2.map((m) => `- ${m}`).join("\n")}`,
          citations: uniq2,
          matched: true,
        };
      }
    }
    const scope = [
      regs.length ? `${regs.length} sheet${regs.length === 1 ? "" : "s"}` : "",
      docs.length ? `${docs.length} document${docs.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(" and ") || "the selected sources";
    const missing = tokens.length ? tokens.slice(0, 6).join(", ") : "matching data";

    // Explain exactly what we searched: per-sheet row counts + which columns
    // are name/identifier-like (via query-match.describeSearchedColumns), so
    // the user can retarget or fix the source.
    const { describeSearchedColumns } = await import("./query-match");
    const perSheet = sheetRows.map(({ reg, rows }) => {
      const cols = allColumns(rows);
      const nameCols = describeSearchedColumns([{ display_name: reg.display_name, headers: cols }]);
      return `- **${reg.display_name}**: scanned ${fmt(rows.length)} rows across columns [${nameCols || cols.slice(0, 6).join(", ")}]`;
    });
    const perDoc = docs.map((d) => `- **${d.name}**: scanned document chunks`);
    const searchedBlock = [...perSheet, ...perDoc].join("\n") || "_(no rows found in the selected sources)_";

    const scopeMarkers = [
      ...regs.map((r) => `[sheet:${r.display_name}]`),
      ...docs.map((d) => `[doc:${d.name}]`),
    ];
    const answer =
      `I don't have that in the selected uploaded sources. ${scopeMarkers[0] ?? ""}\n\n` +
      `**Searched:** ${scope}.\n${searchedBlock}\n\n` +
      `**Missing tokens:** ${missing}.\n\n` +
      `Try rephrasing with a specific name, ID, date, or column value, or pick a different sheet/document from the source picker.` +
      (scopeMarkers.length ? `\n\nSources:\n${scopeMarkers.map((m) => `- ${m}`).join("\n")}` : "");
    return { answer, citations: scopeMarkers, matched: false };

  }



  const answer =
    parts.join("\n") +
    `\n\nSources:\n${uniqCites.map((m) => `- ${m}`).join("\n")}` +
    `\n\n_Answered directly from the selected sources (AI provider unavailable — used local search over your sheets and documents)._`;
  return { answer, citations: uniqCites, matched: true };
}

function emitRowInline(
  row: StoredRow,
  reg: SheetReg,
  cites: string[],
  ledgerSink?: DeterministicLedgerEntry[],
): string {
  const marker = `[sheet:${reg.display_name} row ${row.row_index + 1}]`;
  cites.push(marker);
  ledgerSink?.push({
    kind: "sheet_row",
    registryId: reg.id,
    sheetLabel: reg.display_name,
    rowIndex: row.row_index,
    data: row.data,
  });
  return marker;
}

async function fetchRows(supabase: any, registryId: string, cap: number): Promise<StoredRow[]> {
  const PAGE = 1000;
  const out: StoredRow[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const { data, error } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", registryId)
      .order("row_index", { ascending: true })
      .range(offset, Math.min(offset + PAGE - 1, cap - 1));
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        row_index: r.row_index,
        data: {
          ...(((r.canonical as Record<string, unknown>) ?? {})),
          ...(((r.extras as Record<string, unknown>) ?? {})),
        },
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
