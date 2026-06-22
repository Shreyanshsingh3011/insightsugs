// Pure-JS aggregations over sheet rows. Authoritative; never delegated to LLM.
import type { ComputedResult } from "./types";

export type SheetSource = {
  label: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

const TOTAL_ROW_RE = /^\s*(grand\s*total|sub[\s-]*total|total)\s*$/i;

export function isTotalRow(row: Record<string, unknown>, columns: string[]): boolean {
  for (const c of columns.slice(0, 2)) {
    const v = row?.[c];
    if (typeof v === "string" && TOTAL_ROW_RE.test(v)) return true;
  }
  return false;
}

export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const cleaned = v.replace(/[, _$₹€£]/g, "").trim();
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Normalise a column-like token to lowercase + stripped punctuation for matching. */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Find best matching column name in a sheet for a free-text token. */
export function matchColumn(sheets: SheetSource[], token: string): { sheet: SheetSource; column: string } | null {
  const t = normKey(token);
  if (!t) return null;
  let best: { sheet: SheetSource; column: string; score: number } | null = null;
  for (const s of sheets) {
    for (const c of s.columns) {
      const nc = normKey(c);
      let score = 0;
      if (nc === t) score = 100;
      else if (nc.includes(t) || t.includes(nc)) score = 60;
      else {
        const tParts = t.split(" ");
        const cParts = new Set(nc.split(" "));
        const overlap = tParts.filter((p) => cParts.has(p)).length;
        if (overlap) score = 20 + overlap * 10;
      }
      if (score > 0 && (!best || score > best.score)) best = { sheet: s, column: c, score };
    }
  }
  return best ? { sheet: best.sheet, column: best.column } : null;
}

export type ParsedAgg =
  | { kind: "sum" | "avg" | "min" | "max"; column: string; sheet?: string; filter?: FilterSpec }
  | { kind: "count"; sheet?: string; filter?: FilterSpec }
  | { kind: "groupCount" | "groupSum"; groupBy: string; column?: string; sheet?: string }
  | { kind: "argmaxCount" | "argminCount"; groupBy: string; sheet?: string };

export type FilterSpec = { column: string; equalsLower: string };

/** Evaluate a parsed aggregation over the given sheets. Returns null if no rows match. */
export function evaluate(parsed: ParsedAgg, sheets: SheetSource[]): ComputedResult | null {
  // Filter to specific sheet if asked.
  const useSheets = parsed.sheet
    ? sheets.filter((s) => normKey(s.label) === normKey(parsed.sheet!) || normKey(s.label).includes(normKey(parsed.sheet!)))
    : sheets;
  if (useSheets.length === 0) return null;

  type RowRef = { sheet: string; row: number; rec: Record<string, unknown> };
  const allRows: RowRef[] = [];
  for (const s of useSheets) {
    s.rows.forEach((rec, idx) => {
      if (isTotalRow(rec, s.columns)) return;
      allRows.push({ sheet: s.label, row: idx, rec });
    });
  }

  // Optional filter
  let filtered = allRows;
  if ("filter" in parsed && parsed.filter) {
    const f = parsed.filter;
    filtered = filtered.filter((r) => {
      const v = r.rec[f.column];
      return v != null && String(v).toLowerCase().includes(f.equalsLower);
    });
  }

  switch (parsed.kind) {
    case "count": {
      const value = filtered.length;
      const filterDesc = "filter" in parsed && parsed.filter ? ` where ${parsed.filter.column} ~ "${parsed.filter.equalsLower}"` : "";
      return {
        formatted: `${fmtNumber(value)}`,
        explanation: `Count of rows${filterDesc} across ${useSheets.map((s) => s.label).join(", ")}.`,
        contributingRows: filtered.slice(0, 50).map((r) => ({ sheet: r.sheet, row: r.row })),
      };
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const nums: { val: number; ref: RowRef }[] = [];
      for (const r of filtered) {
        const n = toNumber(r.rec[parsed.column]);
        if (n !== null) nums.push({ val: n, ref: r });
      }
      if (nums.length === 0) return null;
      let value = 0;
      if (parsed.kind === "sum") value = nums.reduce((a, b) => a + b.val, 0);
      else if (parsed.kind === "avg") value = nums.reduce((a, b) => a + b.val, 0) / nums.length;
      else if (parsed.kind === "min") value = nums.reduce((a, b) => (b.val < a ? b.val : a), nums[0].val);
      else value = nums.reduce((a, b) => (b.val > a ? b.val : a), nums[0].val);
      const contributing = (parsed.kind === "min" || parsed.kind === "max"
        ? nums.filter((n) => n.val === value)
        : nums
      ).slice(0, 50).map((n) => ({ sheet: n.ref.sheet, row: n.ref.row }));
      const label = { sum: "Sum", avg: "Average", min: "Min", max: "Max" }[parsed.kind];
      return {
        formatted: fmtNumber(value),
        explanation: `${label} of ${parsed.column} over ${nums.length} rows in ${useSheets.map((s) => s.label).join(", ")}.`,
        contributingRows: contributing,
      };
    }
    case "groupCount":
    case "groupSum": {
      const buckets = new Map<string, { value: number; refs: RowRef[] }>();
      for (const r of filtered) {
        const keyRaw = r.rec[parsed.groupBy];
        const key = keyRaw == null || keyRaw === "" ? "(blank)" : String(keyRaw);
        let b = buckets.get(key);
        if (!b) { b = { value: 0, refs: [] }; buckets.set(key, b); }
        if (parsed.kind === "groupCount") b.value += 1;
        else {
          const n = parsed.column ? toNumber(r.rec[parsed.column]) : null;
          if (n !== null) b.value += n;
        }
        b.refs.push(r);
      }
      if (buckets.size === 0) return null;
      const entries = [...buckets.entries()].sort((a, b) => b[1].value - a[1].value);
      const lines = entries.slice(0, 12).map(([k, v]) => `${k}: ${fmtNumber(v.value)}`);
      const contributing = entries.flatMap(([, v]) => v.refs).slice(0, 50).map((r) => ({ sheet: r.sheet, row: r.row }));
      return {
        formatted: lines.join("\n"),
        explanation: `${parsed.kind === "groupCount" ? "Count" : `Sum of ${parsed.column}`} grouped by ${parsed.groupBy}.`,
        contributingRows: contributing,
      };
    }
    case "argmaxCount":
    case "argminCount": {
      const buckets = new Map<string, RowRef[]>();
      for (const r of filtered) {
        const keyRaw = r.rec[parsed.groupBy];
        const key = keyRaw == null || keyRaw === "" ? "(blank)" : String(keyRaw);
        const b = buckets.get(key) ?? [];
        b.push(r);
        buckets.set(key, b);
      }
      if (buckets.size === 0) return null;
      const entries = [...buckets.entries()];
      entries.sort((a, b) => parsed.kind === "argmaxCount" ? b[1].length - a[1].length : a[1].length - b[1].length);
      const [topKey, topRefs] = entries[0];
      return {
        formatted: `${topKey} (${fmtNumber(topRefs.length)} rows)`,
        explanation: `${parsed.kind === "argmaxCount" ? "Group with the most" : "Group with the fewest"} rows by ${parsed.groupBy}.`,
        contributingRows: topRefs.slice(0, 50).map((r) => ({ sheet: r.sheet, row: r.row })),
      };
    }
  }
  return null;
}
