// Server-only in-memory cache for chatbot tool results and final answers.
// Reduces round-trips to OpenRouter free models (which are rate-limited) and
// speeds up repeat questions against an unchanged dashboard snapshot.
//
// Two caches share a single LRU store keyed by SHA-256 of stable JSON.
//   - Tool-result cache: keyed by (toolName, input, ctxFingerprint). Short TTL.
//   - Final-answer cache: keyed by (question, routedTo, ctxFingerprint). Short TTL.

type Entry<T> = { v: T; exp: number };

const MAX_ENTRIES = 500;
const store = new Map<string, Entry<unknown>>();

function set<T>(key: string, value: T, ttlMs: number) {
  if (store.size >= MAX_ENTRIES) {
    // evict oldest (Map preserves insertion order)
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  store.set(key, { v: value, exp: Date.now() + ttlMs });
}

function get<T>(key: string): T | undefined {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return undefined;
  if (Date.now() > e.exp) {
    store.delete(key);
    return undefined;
  }
  // refresh recency
  store.delete(key);
  store.set(key, e);
  return e.v;
}

function stableStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(input));
}

// Non-crypto FNV-1a 32-bit hash — cache keys don't need cryptographic strength,
// only stable + fast + collision-resistant enough for a 500-entry LRU.
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * A short, stable fingerprint of the dashboard snapshot the tools operate on.
 * Row-heavy fields collapse to (length + first/last citation) so the fingerprint
 * changes as soon as the visible data changes, but a fresh 2-min sync of the
 * *same* rows keeps the same fingerprint.
 */
export function ctxFingerprintSync(ctx: unknown): string {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const summarizeArr = (arr: unknown): unknown => {
    if (!Array.isArray(arr)) return null;
    if (arr.length === 0) return { n: 0 };
    return { n: arr.length, first: arr[0], last: arr[arr.length - 1] };
  };
  const shape = {
    projectId: c.projectId,
    projectLabel: c.projectLabel,
    rowScope: c.rowScope,
    filters: c.filters,
    totals: c.totals,
    riskScore: c.riskScore,
    rows: summarizeArr(c.rows),
    tatRows: summarizeArr(c.tatRows),
    flags: summarizeArr(c.flags),
    actions: summarizeArr(c.actions),
    personRanking: summarizeArr(c.personRanking),
  };
  return fnv1a(stableStringify(shape));
}

export async function ctxFingerprint(ctx: unknown): Promise<string> {
  return ctxFingerprintSync(ctx);
}

const TOOL_TTL_MS = 60_000; // 1 min — matches the 2-min sheet-sync cadence
const ANSWER_TTL_MS = 5 * 60_000; // 5 min — repeat "what's late today?" style

// Sync fast-path used inside tool `execute()` blocks — avoids awaiting SHA.
export function getCachedToolResultSync(toolName: string, input: unknown, ctxFp: string): unknown | undefined {
  const key = "tool:" + fnv1a(`${toolName}|${ctxFp}|${stableStringify(input)}`);
  return get(key);
}
export function setCachedToolResultSync(toolName: string, input: unknown, ctxFp: string, output: unknown): void {
  const key = "tool:" + fnv1a(`${toolName}|${ctxFp}|${stableStringify(input)}`);
  set(key, output, TOOL_TTL_MS);
}

// Async SHA-256 variants — used by the answer cache where a stronger hash
// is preferred and the extra ~1ms is invisible next to a model round-trip.
export async function getCachedToolResult(
  toolName: string, input: unknown, ctxFp: string,
): Promise<unknown | undefined> {
  const key = "tool:" + (await sha256(`${toolName}|${ctxFp}|${stableStringify(input)}`));
  return get(key);
}
export async function setCachedToolResult(
  toolName: string, input: unknown, ctxFp: string, output: unknown,
): Promise<void> {
  const key = "tool:" + (await sha256(`${toolName}|${ctxFp}|${stableStringify(input)}`));
  set(key, output, TOOL_TTL_MS);
}

export async function getCachedAnswer(
  question: string, routedTo: string, ctxFp: string,
): Promise<string | undefined> {
  const q = question.trim().toLowerCase();
  if (!q) return undefined;
  const key = "ans:" + (await sha256(`${routedTo}|${ctxFp}|${q}`));
  return get<string>(key);
}
export async function setCachedAnswer(
  question: string, routedTo: string, ctxFp: string, text: string,
): Promise<void> {
  const q = question.trim().toLowerCase();
  if (!q || !text) return;
  const key = "ans:" + (await sha256(`${routedTo}|${ctxFp}|${q}`));
  set(key, text, ANSWER_TTL_MS);
}

/** Tool names whose outputs are safe to cache (pure reads over the snapshot). */
export const CACHEABLE_TOOLS = new Set([
  "getDashboardSummary",
  "getNextBestActions",
  "getPersonWorkload",
  "topDelays",
  "filterActivities",
  "getOpenAlerts",
  "queryProjects",
  "get_cell",
  "date_query_rows",
  "investigateDelay",
  "summarizeThread",
  "joinSheets",
]);

/** Test-only: clear the whole cache. */
export function _resetAgentCache() {
  store.clear();
}
