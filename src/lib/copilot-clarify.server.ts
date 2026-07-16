// Copilot ambiguity option ranking + clarify-session persistence.
//
// Purpose:
//   1. Rank candidate clarification options (sheets, columns, time windows,
//      entities) by lightweight semantic similarity (token overlap over the
//      user's query) + popularity (row count / occurrence count). Returns the
//      best 2–4 options — no LLM calls, no embedding lookups on the hot path.
//   2. Persist each ambiguity turn into public.copilot_clarify_sessions so a
//      follow-up user reply can be matched back to the offered options and
//      the resolved scope (intent + sheet/column/entity/time_window) can be
//      re-applied on subsequent turns without re-asking.
//
// Session lifecycle:
//   status='pending'  → we asked, waiting for the user's reply.
//   status='resolved' → user picked one of the options; scope re-usable.
//   status='expired'  → older than SESSION_TTL_MS, ignored.

const SESSION_TTL_MS = 20 * 60 * 1000; // 20 minutes.

// ---------- token utilities ----------

const STOP = new Set([
  "the","a","an","of","in","on","at","for","to","and","or","by","with","is","are",
  "what","which","how","why","when","who","where","this","that","these","those",
  "show","give","list","tell","me","us","my","our","your","it","them","they",
  "please","kindly","some","any","all","from","about","across","between","vs",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));
}

// Token-overlap similarity — cheap, deterministic, no external calls.
// Returns 0..1 (Jaccard-ish, biased toward recall on the shorter side).
function tokenSimilarity(term: string, query: string): number {
  const a = new Set(tokenize(term));
  const b = new Set(tokenize(query));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

// popularity ∈ [0, ∞) → log-normalized weight.
function popularityWeight(popularity: number): number {
  if (popularity <= 0) return 0;
  return Math.log2(1 + popularity);
}

// ---------- ranking primitives ----------

export type RankableOption = {
  /** Human-facing label used verbatim in the clarify question. */
  label: string;
  /** Category the option was drawn from (for the model + debugging). */
  kind: "sheet" | "column" | "time_window" | "entity" | "document";
  /** Optional stable id for later resolution. */
  id?: string;
  /** Raw popularity signal — row count, occurrence count, etc. */
  popularity?: number;
};

export type CatalogSheet = {
  id: string;
  name: string;
  rows: number;
  columns: string[];
};

export type CatalogDoc = {
  id: string;
  name: string;
  pages: number;
};

const TIME_WINDOWS: RankableOption[] = [
  { label: "Last 7 days", kind: "time_window", popularity: 3 },
  { label: "Last 30 days", kind: "time_window", popularity: 4 },
  { label: "Last 90 days", kind: "time_window", popularity: 2 },
  { label: "This quarter", kind: "time_window", popularity: 2 },
  { label: "Year to date", kind: "time_window", popularity: 1 },
];

function rank(query: string, options: RankableOption[], limit = 4): RankableOption[] {
  const scored = options.map((o) => {
    const sim = tokenSimilarity(o.label, query);
    const pop = popularityWeight(o.popularity ?? 0);
    // Semantic overlap dominates; popularity breaks ties for equally-relevant items.
    const score = sim * 10 + pop * 0.5;
    return { o, score, sim, pop };
  });
  scored.sort((a, b) => b.score - a.score);
  // Drop clearly-irrelevant items only when we already have ≥2 relevant ones.
  const relevant = scored.filter((s) => s.sim > 0 || s.pop > 0);
  const pool = relevant.length >= 2 ? relevant : scored;
  const seen = new Set<string>();
  const out: RankableOption[] = [];
  for (const s of pool) {
    const key = `${s.o.kind}:${s.o.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.o);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- public option builder ----------

export type AmbiguityKind =
  | "sheet_unspecified"     // multi-sheet, no sheet named
  | "column_unspecified"    // metric/column phrase maps to multiple columns
  | "time_unspecified"      // "recent" / "lately" with no window
  | "entity_ambiguous"      // an ID/name matches multiple rows
  | "generic";

export function buildRankedOptions(input: {
  question: string;
  ambiguityKinds: AmbiguityKind[];
  catalog: { sheets: CatalogSheet[]; documents: CatalogDoc[] };
  columnHitCounts?: Record<string, number>;
  entityCandidates?: Array<{ label: string; count: number }>;
  limit?: number;
}): RankableOption[] {
  const { question, ambiguityKinds, catalog, columnHitCounts, entityCandidates } = input;
  const limit = input.limit ?? 4;
  const wants = new Set(ambiguityKinds);
  const pool: RankableOption[] = [];

  if (wants.has("sheet_unspecified") || wants.has("generic")) {
    for (const s of catalog.sheets) {
      pool.push({ label: `Sheet: ${s.name}`, kind: "sheet", id: s.id, popularity: s.rows });
    }
    for (const d of catalog.documents) {
      pool.push({ label: `Document: ${d.name}`, kind: "document", id: d.id, popularity: d.pages });
    }
  }

  if (wants.has("column_unspecified")) {
    // Collect every column across selected sheets with its occurrence count.
    const colCounts = new Map<string, number>();
    for (const s of catalog.sheets) {
      for (const col of s.columns) {
        colCounts.set(col, (colCounts.get(col) ?? 0) + (columnHitCounts?.[col] ?? 1));
      }
    }
    for (const [col, count] of colCounts) {
      pool.push({ label: `Column: ${col}`, kind: "column", popularity: count });
    }
  }

  if (wants.has("time_unspecified")) {
    pool.push(...TIME_WINDOWS);
  }

  if (wants.has("entity_ambiguous") && entityCandidates?.length) {
    for (const e of entityCandidates) {
      pool.push({ label: e.label, kind: "entity", popularity: e.count });
    }
  }

  return rank(question, pool, limit);
}

// ---------- reply → option matching ----------

/**
 * Try to identify which of the offered options the user's reply refers to.
 * Handles: numeric picks ("1", "option 2"), verbatim label mentions, and
 * label-suffix mentions (e.g. option "Sheet: Bihar Projects" matched by the
 * word "bihar" alone).
 */
export function matchReplyToOption(
  reply: string,
  options: RankableOption[],
): { option: RankableOption; confidence: number } | null {
  if (!reply || !options.length) return null;
  const cleaned = reply.trim().toLowerCase();

  // 1. Numeric pick.
  const numMatch = cleaned.match(/^(?:option\s*)?([1-9])\b/);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (options[idx]) return { option: options[idx], confidence: 1 };
  }

  // 2. Verbatim label / label-suffix mention (strip "Sheet: " / "Column: " prefix).
  let best: { option: RankableOption; confidence: number } | null = null;
  for (const o of options) {
    const raw = o.label.toLowerCase();
    const suffix = raw.replace(/^(sheet|column|document):\s*/i, "");
    if (cleaned.includes(raw)) {
      return { option: o, confidence: 1 };
    }
    if (suffix.length >= 3 && cleaned.includes(suffix)) {
      const conf = 0.9;
      if (!best || conf > best.confidence) best = { option: o, confidence: conf };
      continue;
    }
    const sim = tokenSimilarity(suffix, cleaned);
    if (sim >= 0.5 && (!best || sim > best.confidence)) {
      best = { option: o, confidence: sim };
    }
  }
  return best;
}

// ---------- persistence ----------

type SupabaseLike = {
  from: (table: string) => any;
};

const scopeKey = (sheetIds: string[], documentIds: string[]) =>
  [...sheetIds].sort().join(",") + "|" + [...documentIds].sort().join(",");

export async function loadRecentClarifySession(
  supabase: SupabaseLike,
  userId: string,
  sheetIds: string[],
  documentIds: string[],
): Promise<{
  pending: null | {
    id: string;
    options: RankableOption[];
    reasons: string[];
    question: string | null;
  };
  resolved: null | {
    id: string;
    scope: {
      intent?: string;
      sheetIds?: string[];
      documentIds?: string[];
      columns?: string[];
      entities?: string[];
      time_window?: string;
      picked_label?: string;
    };
    question: string | null;
  };
}> {
  const cutoff = new Date(Date.now() - SESSION_TTL_MS).toISOString();
  const key = scopeKey(sheetIds, documentIds);
  const { data, error } = await supabase
    .from("copilot_clarify_sessions")
    .select("id, status, options, reasons, resolved_scope, sheet_ids, document_ids, question, created_at")
    .eq("user_id", userId)
    .in("status", ["pending", "resolved"])
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !data) return { pending: null, resolved: null };

  let pending: any = null;
  let resolved: any = null;
  for (const row of data) {
    const rowKey = scopeKey(row.sheet_ids ?? [], row.document_ids ?? []);
    if (rowKey !== key) continue;
    if (!pending && row.status === "pending") pending = row;
    if (!resolved && row.status === "resolved") resolved = row;
    if (pending && resolved) break;
  }
  return {
    pending: pending
      ? {
          id: pending.id,
          options: (pending.options ?? []) as RankableOption[],
          reasons: (pending.reasons ?? []) as string[],
          question: pending.question ?? null,
        }
      : null,
    resolved: resolved
      ? { id: resolved.id, scope: resolved.resolved_scope ?? {}, question: resolved.question ?? null }
      : null,
  };
}

export async function savePendingClarifySession(
  supabase: SupabaseLike,
  userId: string,
  input: {
    sheetIds: string[];
    documentIds: string[];
    reasons: string[];
    options: RankableOption[];
    question: string;
  },
): Promise<void> {
  await supabase.from("copilot_clarify_sessions").insert({
    user_id: userId,
    sheet_ids: input.sheetIds,
    document_ids: input.documentIds,
    status: "pending",
    reasons: input.reasons,
    options: input.options,
    question: input.question,
  });
}

export async function markClarifySessionResolved(
  supabase: SupabaseLike,
  sessionId: string,
  scope: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("copilot_clarify_sessions")
    .update({ status: "resolved", resolved_scope: scope })
    .eq("id", sessionId);
}
