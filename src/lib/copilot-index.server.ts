// In-memory index for a selected sheet. Built once per (registryId, row-count)
// and cached at module scope so subsequent copilot turns in the same Worker
// isolate reuse it instead of re-scanning every row from scratch.
//
// The index precomputes:
//   • rows              — the full row array (row_index + merged data)
//   • byIndex           — Map<row_index, data> for O(1) lookup
//   • columns           — union of all column names
//   • haystackByIndex   — normalized "col:val | col:val" haystack per row
//   • tokenPostings     — inverted index token → Set<row_index> for token AND scans
//   • valuePostings     — column → normalizedValue → row_index[] for eq/contains
//   • numericByColumn   — column → sorted [{n, row_index}] for range queries
//
// Everything derives from `fetchAllRows`, so if the row-set changes the cache
// is discarded and rebuilt. Small enough to stay under Worker memory even for
// the 50k-row stock summary sheets.

import { fetchAllRows } from "./copilot-helpers.server";
import { normalizeText } from "./query-match";

export type SheetIndex = {
  registryId: string;
  rows: Array<{ row_index: number; data: Record<string, unknown> }>;
  byIndex: Map<number, Record<string, unknown>>;
  columns: string[];
  haystackByIndex: Map<number, string>;
  tokenPostings: Map<string, Set<number>>;
  valuePostings: Map<string, Map<string, number[]>>;
  numericByColumn: Map<string, Array<{ n: number; row_index: number }>>;
  builtAt: number;
};

type CacheEntry = { key: string; index: SheetIndex; lastUsed: number };

const CACHE = new Map<string, CacheEntry>();
const MAX_ENTRIES = 8; // small — big sheets are heavy

function tokenizeForPostings(s: string): string[] {
  // Split normalized text on whitespace, keep tokens length >= 2.
  const out: string[] = [];
  for (const t of s.split(" ")) {
    if (t.length >= 2) out.push(t);
  }
  return out;
}

function buildIndex(
  registryId: string,
  rows: Array<{ row_index: number; data: Record<string, unknown> }>,
): SheetIndex {
  const byIndex = new Map<number, Record<string, unknown>>();
  const columnSet = new Set<string>();
  const haystackByIndex = new Map<number, string>();
  const tokenPostings = new Map<string, Set<number>>();
  const valuePostings = new Map<string, Map<string, number[]>>();
  const numericByColumn = new Map<string, Array<{ n: number; row_index: number }>>();

  for (const r of rows) {
    byIndex.set(r.row_index, r.data);
    for (const k of Object.keys(r.data)) columnSet.add(k);

    // Per-row haystack
    const parts: string[] = [];
    for (const [k, v] of Object.entries(r.data)) {
      if (v == null || v === "") continue;
      parts.push(String(k));
      parts.push(typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const hay = normalizeText(parts.join(" "));
    haystackByIndex.set(r.row_index, hay);

    // Token postings (deduped per row)
    const seenTok = new Set<string>();
    for (const t of tokenizeForPostings(hay)) {
      if (seenTok.has(t)) continue;
      seenTok.add(t);
      let bucket = tokenPostings.get(t);
      if (!bucket) {
        bucket = new Set<number>();
        tokenPostings.set(t, bucket);
      }
      bucket.add(r.row_index);
    }

    // Per-column value postings + numeric sorted lists
    for (const [k, v] of Object.entries(r.data)) {
      if (v == null || v === "") continue;
      const sv = typeof v === "object" ? JSON.stringify(v) : String(v);
      const nv = sv.toLowerCase().trim();

      let colMap = valuePostings.get(k);
      if (!colMap) {
        colMap = new Map<string, number[]>();
        valuePostings.set(k, colMap);
      }
      let arr = colMap.get(nv);
      if (!arr) {
        arr = [];
        colMap.set(nv, arr);
      }
      arr.push(r.row_index);

      const n = Number(sv);
      if (Number.isFinite(n)) {
        let nums = numericByColumn.get(k);
        if (!nums) {
          nums = [];
          numericByColumn.set(k, nums);
        }
        nums.push({ n, row_index: r.row_index });
      }
    }
  }

  for (const nums of numericByColumn.values()) nums.sort((a, b) => a.n - b.n);

  return {
    registryId,
    rows,
    byIndex,
    columns: Array.from(columnSet),
    haystackByIndex,
    tokenPostings,
    valuePostings,
    numericByColumn,
    builtAt: Date.now(),
  };
}

function evictIfNeeded() {
  if (CACHE.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, e] of CACHE.entries()) {
    if (e.lastUsed < oldestTs) {
      oldestTs = e.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) CACHE.delete(oldestKey);
}

export async function getSheetIndex(
  supabase: any,
  registryId: string,
): Promise<SheetIndex> {
  // Fingerprint = row count + max created_at. Row count alone is unsafe for
  // sheet refreshes that replace rows with the same length, which made Copilot
  // answer from stale indexes after uploaded/future sheet changes.
  const [{ count }, latestRes] = await Promise.all([
    supabase
      .from("sheet_rows")
      .select("row_index", { count: "exact", head: true })
      .eq("sheet_registry_id", registryId),
    supabase
      .from("sheet_rows")
      .select("created_at")
      .eq("sheet_registry_id", registryId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const rowCount = count ?? 0;
  const newest = latestRes?.data?.created_at ?? "none";
  const cacheKey = `${registryId}:${rowCount}:${newest}`;

  const cached = CACHE.get(cacheKey);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.index;
  }

  // Drop any stale entry for this registry (different fingerprint).
  for (const [k] of CACHE) {
    if (k.startsWith(`${registryId}:`)) CACHE.delete(k);
  }

  const rows = await fetchAllRows(supabase, registryId);
  const index = buildIndex(registryId, rows);
  CACHE.set(cacheKey, { key: cacheKey, index, lastUsed: Date.now() });
  evictIfNeeded();
  return index;
}

/**
 * Fast token-AND candidate lookup using the inverted index. Returns the
 * smallest posting list intersected with the others, avoiding a full-row
 * scan when at least one token is selective.
 */
export function candidatesForTokens(index: SheetIndex, tokens: string[]): number[] | null {
  if (tokens.length === 0) return null;
  const lists: Set<number>[] = [];
  for (const t of tokens) {
    const bucket = index.tokenPostings.get(t);
    if (!bucket || bucket.size === 0) return []; // AND with empty → empty
    lists.push(bucket);
  }
  lists.sort((a, b) => a.size - b.size);
  const [first, ...rest] = lists;
  const out: number[] = [];
  outer: for (const idx of first) {
    for (const r of rest) if (!r.has(idx)) continue outer;
    out.push(idx);
  }
  return out;
}

export function candidatesForAnyToken(index: SheetIndex, tokens: string[]): number[] | null {
  if (tokens.length === 0) return null;
  const out = new Set<number>();
  for (const t of tokens) {
    const bucket = index.tokenPostings.get(t);
    if (!bucket) continue;
    for (const rowIndex of bucket) out.add(rowIndex);
  }
  return out.size ? Array.from(out) : null;
}
