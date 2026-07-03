import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";
import { callEmergent } from "@/lib/emergent-client";


const SHEET_TYPE_ENUM = z.enum([
  "generic",
  "progress",
  "material_reconciliation",
  "procurement",
  "contractor_billing",
  "bill_tracking",
  "pms",
  "tat",
]);

// Accepts any HTTPS endpoint that returns JSON in one of the shapes
// handled by normalizeAppsScriptPayload — Google Apps Script web apps,
// Emergent connector URLs, or any custom API that returns rows.
const APPS_SCRIPT_URL = z
  .string()
  .url()
  .refine((u) => /^https:\/\//.test(u), "Must be an https:// URL");

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function isNumericLike(s: string) {
  const t = s.trim();
  if (!t) return false;
  // Strip common formatted-number characters: Indian/US commas, currency, %, parentheses.
  const stripped = t.replace(/[,₹$€£%()\s]/g, "");
  return stripped.length > 0 && /^-?\d+(\.\d+)?$/.test(stripped);
}

function spreadsheetColumnIndex(label: string): number | null {
  const s = label.trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function spreadsheetColumnLabel(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function isSequentialSpreadsheetHeader(row: unknown[]) {
  const cells = row.map(cellText).filter(Boolean);
  if (cells.length < 3) return false;
  const indexes = cells.map(spreadsheetColumnIndex);
  if (indexes.some((v) => v == null)) return false;
  for (let i = 1; i < indexes.length; i++) {
    if ((indexes[i] ?? 0) !== (indexes[i - 1] ?? 0) + 1) return false;
  }
  return true;
}

function looksLikeHeaderRow(row: unknown[]) {
  const cells = row.map(cellText).filter(Boolean);
  if (cells.length < 2) return false;
  if (isSequentialSpreadsheetHeader(cells)) return false;
  const numericCount = cells.filter(isNumericLike).length;
  if (numericCount / cells.length >= 0.5) return false;
  const textLabelCount = cells.filter((c) => /[A-Za-z]/.test(c) && !isNumericLike(c)).length;
  return textLabelCount >= Math.max(2, Math.ceil(cells.length * 0.35));
}

function normalizeSearchText(value: unknown): string {
  return cellText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function mergedSheetRow(row: { canonical?: unknown; extras?: unknown }): Record<string, unknown> {
  return {
    ...(((row.canonical as Record<string, unknown>) ?? {})),
    ...(((row.extras as Record<string, unknown>) ?? {})),
  };
}

function storedRowsLookMisread(rows: { canonical?: unknown; extras?: unknown }[]) {
  const firstWithData = rows.find((r) => Object.keys(mergedSheetRow(r)).length > 0);
  if (!firstWithData) return false;
  const merged = mergedSheetRow(firstWithData);
  const keys = Object.keys(merged);
  if (keys.length >= 3) {
    const numericKeyRatio = keys.filter(isNumericLike).length / keys.length;
    if (numericKeyRatio >= 0.5) return true;
    if (isSequentialSpreadsheetHeader(keys)) return true;
  }
  // A common API shape stores row 0 as the real header values under A/B/C keys.
  // If those header-like labels landed as data, refresh with the stricter parser.
  return looksLikeHeaderRow(Object.values(merged));
}

// ===== Operations layer (NotebookLM-style analytical queries) =====

function parseNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const stripped = s.replace(/[,₹$€£%()\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(stripped)) return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
}

function resolveColumn(want: string | null | undefined, available: string[]): string | null {
  if (!want) return null;
  if (available.includes(want)) return want;
  const lc = want.toLowerCase().trim();
  const exact = available.find((c) => c.toLowerCase().trim() === lc);
  if (exact) return exact;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const wantN = norm(want);
  return available.find((c) => norm(c) === wantN) || available.find((c) => norm(c).includes(wantN) || wantN.includes(norm(c))) || null;
}

function compareValues(a: unknown, b: unknown, dir: "asc" | "desc"): number {
  const an = parseNumber(a);
  const bn = parseNumber(b);
  let cmp: number;
  if (an != null && bn != null) cmp = an - bn;
  else cmp = String(a ?? "").localeCompare(String(b ?? ""));
  return dir === "desc" ? -cmp : cmp;
}

type OpSpec = {
  sheet?: string;
  op: "top_n" | "bottom_n" | "group_by" | "filter_sort" | "aggregate" | "distribution" | "none";
  measure?: string | null;
  agg?: "sum" | "avg" | "count" | "min" | "max" | null;
  dimension?: string | null;
  filter?: { column: string; op: string; value: unknown }[];
  sort_by?: string | null;
  sort_dir?: "asc" | "desc";
  n?: number;
};

function applyFilters(
  rows: { row_index: number; data: Record<string, unknown> }[],
  filters: OpSpec["filter"],
  columns: string[],
) {
  if (!filters?.length) return rows;
  return rows.filter((r) => {
    for (const f of filters) {
      const col = resolveColumn(f.column, columns);
      if (!col) continue;
      const v = r.data[col];
      const fv = f.value;
      const sv = String(v ?? "").toLowerCase();
      const sfv = String(fv ?? "").toLowerCase();
      const nv = parseNumber(v);
      const nfv = parseNumber(fv);
      switch (f.op) {
        case "eq": if (sv !== sfv) return false; break;
        case "contains": if (!sv.includes(sfv)) return false; break;
        case "gt": if (nv == null || nfv == null || !(nv > nfv)) return false; break;
        case "gte": if (nv == null || nfv == null || !(nv >= nfv)) return false; break;
        case "lt": if (nv == null || nfv == null || !(nv < nfv)) return false; break;
        case "lte": if (nv == null || nfv == null || !(nv <= nfv)) return false; break;
        default: break;
      }
    }
    return true;
  });
}

function executeOperation(
  spec: OpSpec,
  group: { label: string; rows: { row_index: number; data: Record<string, unknown> }[] },
): { spec: OpSpec; result: unknown; resolved: Record<string, string | null> } | null {
  if (!spec || spec.op === "none") return null;
  const columns = Array.from(group.rows.reduce((s, r) => { Object.keys(r.data).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const measure = resolveColumn(spec.measure ?? null, columns);
  const dimension = resolveColumn(spec.dimension ?? null, columns);
  const sortBy = resolveColumn(spec.sort_by ?? null, columns) || measure || dimension;
  const resolved = { measure, dimension, sort_by: sortBy };

  const filtered = applyFilters(group.rows, spec.filter, columns);
  const n = Math.min(Math.max(spec.n ?? 10, 1), 100);

  if (spec.op === "top_n" || spec.op === "bottom_n") {
    if (!measure && !sortBy) return null;
    const key = (sortBy || measure)!;
    const dir = spec.op === "top_n" ? "desc" : "asc";
    const sorted = [...filtered].sort((a, b) => compareValues(a.data[key], b.data[key], dir));
    const out = sorted.slice(0, n).map((r) => {
      const row: Record<string, unknown> = { row_index: r.row_index };
      if (dimension) row[dimension] = r.data[dimension];
      row[key] = r.data[key];
      // Include up to 3 additional columns for context
      const extras = columns.filter((c) => c !== dimension && c !== key).slice(0, 3);
      for (const c of extras) row[c] = r.data[c];
      return row;
    });
    return { spec, result: out, resolved };
  }

  if (spec.op === "group_by") {
    if (!dimension) return null;
    const groups = new Map<string, { values: number[]; count: number }>();
    for (const r of filtered) {
      const key = String(r.data[dimension] ?? "(blank)");
      const g = groups.get(key) ?? { values: [], count: 0 };
      g.count++;
      if (measure) {
        const n2 = parseNumber(r.data[measure]);
        if (n2 != null) g.values.push(n2);
      }
      groups.set(key, g);
    }
    const agg = spec.agg ?? (measure ? "sum" : "count");
    const out = Array.from(groups.entries()).map(([k, g]) => {
      let val: number;
      if (agg === "count" || !measure) val = g.count;
      else if (agg === "sum") val = g.values.reduce((a, b) => a + b, 0);
      else if (agg === "avg") val = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : 0;
      else if (agg === "min") val = g.values.length ? Math.min(...g.values) : 0;
      else if (agg === "max") val = g.values.length ? Math.max(...g.values) : 0;
      else val = g.count;
      return { [dimension]: k, [`${agg}_${measure ?? "rows"}`]: Math.round(val * 100) / 100, count: g.count };
    });
    out.sort((a, b) => {
      const va = Number((a as any)[`${agg}_${measure ?? "rows"}`]);
      const vb = Number((b as any)[`${agg}_${measure ?? "rows"}`]);
      return (spec.sort_dir === "asc" ? 1 : -1) * (va - vb);
    });
    return { spec, result: out.slice(0, 50), resolved };
  }

  if (spec.op === "aggregate") {
    if (!measure) return { spec, result: { count: filtered.length }, resolved };
    const nums = filtered.map((r) => parseNumber(r.data[measure])).filter((v): v is number => v != null);
    const agg = spec.agg ?? "sum";
    let val = 0;
    if (agg === "count") val = filtered.length;
    else if (agg === "sum") val = nums.reduce((a, b) => a + b, 0);
    else if (agg === "avg") val = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    else if (agg === "min") val = nums.length ? Math.min(...nums) : 0;
    else if (agg === "max") val = nums.length ? Math.max(...nums) : 0;
    return { spec, result: { [`${agg}_${measure}`]: Math.round(val * 100) / 100, rows_considered: filtered.length, numeric_values: nums.length }, resolved };
  }

  if (spec.op === "distribution") {
    if (!dimension) return null;
    const counts = new Map<string, number>();
    for (const r of filtered) {
      const k = String(r.data[dimension] ?? "(blank)");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = Array.from(counts.entries())
      .map(([value, count]) => ({ [dimension]: value, count }))
      .sort((a, b) => Number((b as any).count) - Number((a as any).count))
      .slice(0, 50);
    return { spec, result: out, resolved };
  }

  if (spec.op === "filter_sort") {
    if (!sortBy) return { spec, result: filtered.slice(0, 50).map((r) => ({ row_index: r.row_index, ...r.data })), resolved };
    const sorted = [...filtered].sort((a, b) => compareValues(a.data[sortBy], b.data[sortBy], spec.sort_dir ?? "desc"));
    return { spec, result: sorted.slice(0, 50).map((r) => ({ row_index: r.row_index, ...r.data })), resolved };
  }

  return null;
}

const MEASURE_HINT = /(value|qty|quantity|amount|total|sum|price|cost|sales|billing|stock|days|delay|count|rate|score|target|achieved|balance|due|paid)/i;

function buildHeuristicRanks(
  group: { label: string; rows: { row_index: number; data: Record<string, unknown> }[] },
): unknown[] {
  const columns = Array.from(group.rows.reduce((s, r) => { Object.keys(r.data).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const numericCols = columns.filter((c) => {
    if (!MEASURE_HINT.test(c)) return false;
    let cnt = 0;
    for (let i = 0; i < Math.min(group.rows.length, 50); i++) if (parseNumber(group.rows[i].data[c]) != null) cnt++;
    return cnt >= 5;
  }).slice(0, 4);
  const dimCol = columns.find((c) => /name|store|item|project|vendor|customer|product|code|id|category|type/i.test(c)) || columns[0];
  const out: unknown[] = [];
  for (const col of numericCols) {
    const sorted = [...group.rows].sort((a, b) => compareValues(a.data[col], b.data[col], "desc"));
    out.push({
      op: "top_n_heuristic",
      measure: col,
      dimension: dimCol,
      top10: sorted.slice(0, 10).map((r) => ({ row_index: r.row_index, [dimCol]: r.data[dimCol], [col]: r.data[col] })),
    });
  }
  return out;
}

/**
 * Apps Script web app response normalizer.
 * Accepts either:
 *   { headers: [...], rows: [[...], ...] }
 *   { values: [[...], ...] }      // first row treated as headers
 *   [{colA: 1, colB: 2}, ...]      // array of objects
 */
function arrayOfObjectsToTable(objs: Record<string, unknown>[]): { headers: string[]; rows: string[][] } {
  const headerSet = new Set<string>();
  for (const o of objs) Object.keys(o).forEach((k) => headerSet.add(k));
  const headers = Array.from(headerSet);
  const rows = objs.map((o) =>
    headers.map((h) => {
      const v = o[h];
      if (v == null) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    }),
  );
  return { headers, rows };
}

// Walks a JSON payload and finds the first useful tabular shape.
function normalizeAppsScriptPayload(payload: unknown): { headers: string[]; rows: string[][] } {
  if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === "object" && payload[0] !== null) {
    return arrayOfObjectsToTable(payload as Record<string, unknown>[]);
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.headers) && Array.isArray(obj.rows)) {
      return {
        headers: (obj.headers as unknown[]).map((h) => String(h ?? "").trim()),
        rows: (obj.rows as unknown[][]).map((r) =>
          (Array.isArray(r) ? r : []).map((c) => (c == null ? "" : String(c))),
        ),
      };
    }
    if (Array.isArray(obj.values) && (obj.values as unknown[]).length > 0) {
      const all = obj.values as unknown[][];
      const headers = (all[0] ?? []).map((h) => String(h ?? "").trim());
      const rows = all.slice(1).map((r) =>
        (Array.isArray(r) ? r : []).map((c) => (c == null ? "" : String(c))),
      );
      return { headers, rows };
    }
    // Common keys used by APIs that wrap rows
    for (const key of ["data", "rows", "records", "items", "results"]) {
      const v = obj[key];
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        return arrayOfObjectsToTable(v as Record<string, unknown>[]);
      }
    }
    // Fallback: scan for the first array-of-objects anywhere in the object
    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null) {
        return arrayOfObjectsToTable(v as Record<string, unknown>[]);
      }
    }
  }
  return { headers: [], rows: [] };
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cur.push(field); field = ""; }
    else if (ch === "\n") { cur.push(field); rows.push(cur); cur = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows };
}

// Convert popular spreadsheet "open" URLs into a fetchable data URL.
function toFetchableUrl(url: string): string {
  // Google Sheets: https://docs.google.com/spreadsheets/d/<id>/edit#gid=<gid>
  const gs = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)/i);
  if (gs) {
    const id = gs[1];
    const gid = url.match(/[?#&]gid=(\d+)/)?.[1];
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ""}`;
  }
  // Excel online share links → try to coerce to download
  if (/^https:\/\/(1drv\.ms|.*\.sharepoint\.com|onedrive\.live\.com)/i.test(url)) {
    return url.includes("download=1") ? url : url + (url.includes("?") ? "&" : "?") + "download=1";
  }
  return url;
}

async function fetchAppsScript(url: string): Promise<{ headers: string[]; rows: string[][] }> {
  const target = toFetchableUrl(url);
  const res = await fetch(target, { redirect: "follow" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Source URL returned ${res.status}: ${text.slice(0, 300)}`);
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  const body = await res.text();

  let table: { headers: string[]; rows: string[][] } | null = null;
  const looksJson = ctype.includes("json") || /^\s*[\[{]/.test(body);
  if (looksJson) {
    try {
      const payload = JSON.parse(body);
      const normalized = normalizeAppsScriptPayload(payload);
      if (normalized.headers.length > 0) table = normalized;
    } catch { /* fall through to CSV */ }
  }
  if (!table && (ctype.includes("csv") || ctype.includes("text/plain") || /,|\n/.test(body))) {
    const csv = parseCsv(body);
    if (csv.headers.length > 0) table = csv;
  }
  if (!table) {
    throw new Error(
      "Couldn't read tabular data from this URL. Provide a JSON endpoint (with rows/headers/values or an array of objects), a Google Sheets share link, or a direct CSV URL.",
    );
  }

  // Some sources have preamble/totals rows, or API rows keyed as A/B/C with
  // the true headers in row 0. Promote the first real text-label header row.
  if (!looksLikeHeaderRow(table.headers) && table.rows.length > 0) {
    let promoted = -1;
    for (let i = 0; i < Math.min(table.rows.length, 20); i++) {
      if (looksLikeHeaderRow(table.rows[i])) { promoted = i; break; }
    }
    if (promoted >= 0) {
      const previousHeaders = table.headers;
      table = {
        headers: table.rows[promoted].map((c, i) => {
          const promotedHeader = cellText(c);
          if (promotedHeader) return promotedHeader;
          return cellText(previousHeaders[i]) || `Column ${i + 1}`;
        }),
        rows: table.rows.slice(promoted + 1),
      };
    }
  }


  // Drop columns whose header is blank or duplicated; rename duplicates with a suffix.
  const seen = new Map<string, number>();
  const keepIdx: number[] = [];
  const finalHeaders: string[] = [];
  table.headers.forEach((raw, i) => {
    const h = String(raw ?? "").trim();
    if (!h) return;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    keepIdx.push(i);
    finalHeaders.push(n === 1 ? h : `${h} (${n})`);
  });
  const finalRows = table.rows.map((r) => keepIdx.map((i) => r[i] ?? ""));
  return { headers: finalHeaders, rows: finalRows };
}


async function proposeMapping(
  sheetType: SheetType,
  headers: string[],
  sampleRows: string[][],
): Promise<Record<string, string | null>> {
  const canonical = CANONICAL_FIELDS[sheetType];
  // No canonical schema (e.g. "generic"): keep every column as an extra.
  if (canonical.length === 0) {
    const result: Record<string, string | null> = {};
    for (const h of headers) result[h] = null;
    return result;
  }
  try {
    const out = await callEmergent<{ mapping?: Record<string, string | null> }>(
      "map-columns",
      { sheetType, canonicalFields: canonical, headers, sampleRows },
    );
    const parsed = out?.mapping ?? {};
    const result: Record<string, string | null> = {};
    for (const h of headers) {
      const v = (parsed as any)[h];
      result[h] = typeof v === "string" && canonical.includes(v) ? v : null;
    }
    return result;
  } catch (e) {
    // Emergent is optional — fall back to heuristic name matching so inspect never fails.
    console.warn("proposeMapping fell back to heuristic:", e instanceof Error ? e.message : e);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const result: Record<string, string | null> = {};
    for (const h of headers) {
      const hn = norm(h);
      if (hn.length < 2) { result[h] = null; continue; }
      const hit =
        canonical.find((c) => norm(c) === hn) ??
        canonical.find((c) => {
          const cn = norm(c);
          return cn.length >= 2 && (hn.includes(cn) || cn.includes(hn));
        });
      result[h] = hit ?? null;
    }
    return result;
  }
}


// Inspect: fetch the Apps Script URL, return headers + sample + AI-suggested mapping
export const inspectSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        appsScriptUrl: APPS_SCRIPT_URL,
        sheetType: SHEET_TYPE_ENUM,
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { headers, rows } = await fetchAppsScript(data.appsScriptUrl);
    const sampleRows = rows.slice(0, 5);
    const mapping = await proposeMapping(data.sheetType as SheetType, headers, sampleRows);
    return {
      headers,
      sampleRows,
      totalRows: rows.length,
      proposedMapping: mapping,
    };
  });

// Register + first sync
export const registerAndSyncSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        appsScriptUrl: APPS_SCRIPT_URL,
        sheetType: SHEET_TYPE_ENUM,
        displayName: z.string().min(1).max(200),
        mapping: z.record(z.string(), z.string().nullable()),
        visibility: z.enum(["private", "public", "shared"]).optional(),
        sharedUserIds: z.array(z.string().uuid()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Only admins may pick anything other than 'private'.
    let visibility: "private" | "public" | "shared" = "private";
    if (data.visibility && data.visibility !== "private") {
      const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
      if (isAdmin) visibility = data.visibility;
    }
    const sharedIds =
      visibility === "shared" ? Array.from(new Set(data.sharedUserIds ?? [])) : [];

    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .insert({
        user_id: userId,
        sheet_type: data.sheetType,
        apps_script_url: data.appsScriptUrl,
        display_name: data.displayName,
        visibility,
      })
      .select("id")
      .single();
    if (regErr) throw new Error(regErr.message);
    const registryId = reg.id as string;

    if (sharedIds.length > 0) {
      await supabase.from("sheet_registry_shares").insert(
        sharedIds.map((uid) => ({ sheet_registry_id: registryId, user_id: uid, created_by: userId })),
      );
    }

    const mappingRows = Object.entries(data.mapping).map(([source, canonical], idx) => ({
      sheet_registry_id: registryId,
      source_header: source,
      canonical_field: canonical,
      position: idx,
    }));
    if (mappingRows.length > 0) {
      const { error: mapErr } = await supabase.from("sheet_column_mappings").insert(mappingRows);
      if (mapErr) throw new Error(mapErr.message);
    }

    await syncRowsInternal(supabase, userId, registryId);
    return { id: registryId };
  });


async function syncRowsInternal(supabase: any, userId: string, registryId: string) {
  const { data: reg, error: regErr } = await supabase
    .from("sheet_registry")
    .select("apps_script_url, user_id")
    .eq("id", registryId)
    .maybeSingle();
  if (regErr) throw new Error(regErr.message);
  if (!reg || reg.user_id !== userId) throw new Error("Sheet not found.");

  const { data: maps, error: mapErr } = await supabase
    .from("sheet_column_mappings")
    .select("source_header, canonical_field, position")
    .eq("sheet_registry_id", registryId)
    .order("position", { ascending: true });
  if (mapErr) throw new Error(mapErr.message);
  const mapping: Record<string, string | null> = {};
  for (const m of maps ?? []) mapping[m.source_header] = m.canonical_field;

  const { headers, rows } = await fetchAppsScript(reg.apps_script_url);

  const toInsert = rows.map((row, idx) => {
    const canonical: Record<string, string> = {};
    const extras: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = row[i] ?? "";
      const target = mapping[h];
      if (target) canonical[target] = cell;
      else extras[h] = cell;
    });
    return {
      sheet_registry_id: registryId,
      row_index: idx,
      canonical,
      extras,
    };
  });

  const { error: delErr } = await supabase
    .from("sheet_rows")
    .delete()
    .eq("sheet_registry_id", registryId);
  if (delErr) throw new Error(delErr.message);

  if (toInsert.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const slice = toInsert.slice(i, i + BATCH);
      const { error } = await supabase.from("sheet_rows").insert(slice);
      if (error) throw new Error(error.message);
    }
  }

  await supabase
    .from("sheet_registry")
    .update({
      last_refreshed_at: new Date().toISOString(),
      row_count: toInsert.length,
    })
    .eq("id", registryId);
}

export const refreshSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ registryId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await syncRowsInternal(context.supabase, context.userId, data.registryId);
    return { ok: true };
  });

export const listSheets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // RLS returns: owner + admin + public + shared-with-me
    const { data, error } = await supabase
      .from("sheet_registry")
      .select(
        "id, sheet_type, display_name, apps_script_url, source_url, row_count, last_refreshed_at, created_at, visibility, user_id",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = (data ?? []).filter((r: any) => r.visibility === "shared").map((r: any) => r.id);
    const shareCounts = new Map<string, number>();
    if (ids.length > 0) {
      const { data: shares } = await supabase
        .from("sheet_registry_shares")
        .select("sheet_registry_id")
        .in("sheet_registry_id", ids);
      for (const s of shares ?? []) {
        shareCounts.set(
          s.sheet_registry_id,
          (shareCounts.get(s.sheet_registry_id) ?? 0) + 1,
        );
      }
    }
    return {
      sheets: (data ?? []).map((r: any) => ({
        ...r,
        share_count: shareCounts.get(r.id) ?? 0,
        is_owner: r.user_id === userId,
      })),
    };
  });


// Update endpoint / source-link / display name for an existing sheet
export const updateSheetMeta = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        registryId: z.string().uuid(),
        appsScriptUrl: APPS_SCRIPT_URL.optional(),
        sourceUrl: z.string().trim().url().max(2000).nullable().optional(),
        displayName: z.string().min(1).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const patch: { apps_script_url?: string; source_url?: string | null; display_name?: string } = {};
    if (data.appsScriptUrl !== undefined) patch.apps_script_url = data.appsScriptUrl;
    if (data.sourceUrl !== undefined) patch.source_url = data.sourceUrl;
    if (data.displayName !== undefined) patch.display_name = data.displayName;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await supabase
      .from("sheet_registry")
      .update(patch)
      .eq("id", data.registryId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Distinct projects pulled from rows of the user's registered sheets
export const listProjectsFromSheets = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: regs } = await supabase
      .from("sheet_registry")
      .select("id, display_name")
      .eq("user_id", userId);
    const regIds = (regs ?? []).map((r) => r.id as string);
    if (regIds.length === 0) return { projects: [] as { name: string; code: string | null; source: string }[] };

    const { data: rows, error } = await supabase
      .from("sheet_rows")
      .select("sheet_registry_id, canonical, extras")
      .in("sheet_registry_id", regIds)
      .limit(5000);
    if (error) throw new Error(error.message);

    const regName = new Map((regs ?? []).map((r) => [r.id as string, r.display_name as string]));
    const NAME_KEYS = ["project_name", "Project Name", "Project", "project", "PROJECT"];
    const CODE_KEYS = ["project_code", "Project Code", "Project_ID", "ProjectId", "project_code".toUpperCase()];

    const pickKey = (obj: Record<string, unknown> | null | undefined, keys: string[]): string | null => {
      if (!obj) return null;
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };

    const seen = new Map<string, { name: string; code: string | null; source: string }>();
    for (const r of rows ?? []) {
      const canonical = r.canonical as Record<string, unknown> | null;
      const extras = r.extras as Record<string, unknown> | null;
      const name = pickKey(canonical, NAME_KEYS) ?? pickKey(extras, NAME_KEYS);
      const code = pickKey(canonical, CODE_KEYS) ?? pickKey(extras, CODE_KEYS);
      if (!name) continue;
      const key = `${name.toLowerCase()}|${(code ?? "").toLowerCase()}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name,
          code,
          source: regName.get(r.sheet_registry_id as string) ?? "",
        });
      }
    }
    return { projects: Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name)) };
  });

// Activities matched to the current user via email-first, name-fallback,
// joined with the user's dependency mapping from `localStorage`-style payload
// supplied by the client (super admin sets it on dashboard).
export const getMyDependentActivities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    // current user identity
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", userId)
      .maybeSingle();
    const myEmail = (profile?.email ?? "").toLowerCase().trim();
    const myName = (profile?.full_name ?? "").toLowerCase().trim();

    // Match across ALL registered sheets (not just user's own) — we identify the
    // user inside each row by email/name columns. Use admin client to bypass RLS
    // (which scopes sheet_rows to the registry owner).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: regs } = await supabaseAdmin
      .from("sheet_registry")
      .select("id, display_name");
    const regIds = (regs ?? []).map((r) => r.id as string);
    if (regIds.length === 0) return { rows: [] };

    const regName = new Map((regs ?? []).map((r) => [r.id as string, r.display_name as string]));

    const { data: rows } = await supabaseAdmin
      .from("sheet_rows")
      .select("sheet_registry_id, row_index, canonical, extras")
      .in("sheet_registry_id", regIds)
      .limit(20000);


    const EMAIL_KEYS = [
      "email", "Email", "EMAIL",
      "assignee_email", "Assignee Email", "Responsible Person Mail ID", "approvers email id",
      "owner_email", "Owner Email",
    ];
    const NAME_KEYS = [
      "assignee", "Assignee", "owner", "Owner",
      "Responsible Person", "responsible_person", "approvers name", "name", "Name",
    ];
    const STATUS_KEYS = ["status", "Status", "Status as on Date"];
    const ACTIVITY_KEYS = [
      "activity", "Activity", "task", "Task",
      "Stages of Process", "Process Descriptions",
    ];
    const DEP_KEYS = ["dependent_activities", "Dependent activities", "Dependent Activities", "depends_on"];

    const pick = (obj: Record<string, unknown> | null | undefined, keys: string[]): string | null => {
      if (!obj) return null;
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };

    type Out = {
      sheet_id: string;
      sheet_name: string;
      row_index: number;
      activity: string;
      status: string | null;
      predecessor: string | null;
      matched_via: "email" | "name";
    };
    const out: Out[] = [];

    for (const r of rows ?? []) {
      const c = r.canonical as Record<string, unknown> | null;
      const e = r.extras as Record<string, unknown> | null;
      const email = (pick(c, EMAIL_KEYS) ?? pick(e, EMAIL_KEYS) ?? "").toLowerCase();
      const name = (pick(c, NAME_KEYS) ?? pick(e, NAME_KEYS) ?? "").toLowerCase();
      let via: "email" | "name" | null = null;
      if (myEmail && email && email === myEmail) via = "email";
      else if (myName && name && name === myName) via = "name";
      if (!via) continue;

      out.push({
        sheet_id: r.sheet_registry_id as string,
        sheet_name: regName.get(r.sheet_registry_id as string) ?? "",
        row_index: r.row_index as number,
        activity: pick(c, ACTIVITY_KEYS) ?? pick(e, ACTIVITY_KEYS) ?? `Row ${r.row_index}`,
        status: pick(c, STATUS_KEYS) ?? pick(e, STATUS_KEYS),
        predecessor: pick(c, DEP_KEYS) ?? pick(e, DEP_KEYS),
        matched_via: via,
      });
    }

    return { rows: out };
  });


export const getSheetDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        registryId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(2000).default(500),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    let { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .select(
        "id, sheet_type, display_name, apps_script_url, row_count, last_refreshed_at",
      )
      .eq("id", data.registryId)
      .eq("user_id", userId)
      .maybeSingle();
    if (regErr) throw new Error(regErr.message);
    if (!reg) throw new Error("Sheet not found.");

    const { data: probeRows } = await supabase
      .from("sheet_rows")
      .select("canonical, extras")
      .eq("sheet_registry_id", data.registryId)
      .order("row_index", { ascending: true })
      .limit(12);
    if (storedRowsLookMisread(probeRows ?? [])) {
      await syncRowsInternal(supabase, userId, data.registryId);
      const refreshed = await supabase
        .from("sheet_registry")
        .select(
          "id, sheet_type, display_name, apps_script_url, row_count, last_refreshed_at",
        )
        .eq("id", data.registryId)
        .eq("user_id", userId)
        .maybeSingle();
      if (refreshed.error) throw new Error(refreshed.error.message);
      reg = refreshed.data ?? reg;
    }

    const { data: maps } = await supabase
      .from("sheet_column_mappings")
      .select("source_header, canonical_field, position")
      .eq("sheet_registry_id", data.registryId)
      .order("position", { ascending: true });

    const { count } = await supabase
      .from("sheet_rows")
      .select("row_index", { count: "exact", head: true })
      .eq("sheet_registry_id", data.registryId);

    const { data: rows } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", data.registryId)
      .order("row_index", { ascending: true })
      .range(data.offset, data.offset + data.limit - 1);

    return {
      registry: reg,
      mappings: maps ?? [],
      rows: rows ?? [],
      totalRows: count ?? 0,
      offset: data.offset,
      limit: data.limit,
    };
  });

export const deleteSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ registryId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("sheet_registry")
      .delete()
      .eq("id", data.registryId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Copilot: answer a question using selected sheets as context
// askCopilot is now a thin adapter around the agentic V2 pipeline in
// src/lib/copilot-agent.functions.ts. Callers keep the same `{answer, sources,
// suggestions}` shape; the tool trace + retrieval ledger are surfaced too but
// older call sites can ignore them.
export const askCopilot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        question: z.string().min(1).max(2000),
        sheetIds: z.array(z.string().uuid()).max(10).default([]),
        documentIds: z.array(z.string().uuid()).max(10).default([]),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(8000),
            }),
          )
          .max(20)
          .default([]),
      })
      .refine((v) => v.sheetIds.length + v.documentIds.length > 0, {
        message: "Select at least one sheet or document.",
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { askCopilotV2 } = await import("./copilot-agent.functions");
    // Call the server fn in-process; TanStack executes the handler directly
    // when invoked server-side and honors the same auth context we already
    // established via requireSupabaseAuth above.
    const res = await (askCopilotV2 as any)({ data });
    return res;
  });

const _legacyAskCopilotDeprecated = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        question: z.string().min(1).max(2000),
        sheetIds: z.array(z.string().uuid()).max(10).default([]),
        documentIds: z.array(z.string().uuid()).max(10).default([]),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(8000),
            }),
          )
          .max(20)
          .default([]),
      })
      .refine((v) => v.sheetIds.length + v.documentIds.length > 0, {
        message: "Select at least one sheet or document.",
      })
      .parse(input),
  )

  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    let regs: { id: string; display_name: string; sheet_type: string }[] = [];
    if (data.sheetIds.length > 0) {
      const { data: r, error: regErr } = await supabase
        .from("sheet_registry")
        .select("id, display_name, sheet_type")
        .in("id", data.sheetIds)
        .eq("user_id", userId);
      if (regErr) throw new Error(regErr.message);
      regs = r ?? [];
    }

    // 1) Computed aggregates across ALL rows (not truncated).
    //    Only meaningful for delay/progress-style sheets — buildDashboardFromSheets
    //    is hard-wired to delay semantics (Delayed/Blocked/Completed/At Risk/Risk Score).
    //    For generic sheets we skip it so the LLM doesn't parrot a zeroed delay template.
    const DELAY_TYPES = new Set(["progress", "pms", "vendor_billing", "delay"]);
    const hasDelaySheet = regs.some((r) => DELAY_TYPES.has(r.sheet_type));
    let aggregates: unknown = null;
    if (data.sheetIds.length > 0 && hasDelaySheet) {
      const { buildDashboardFromSheets } = await import("./dashboard.functions");
      try {
        aggregates = await (buildDashboardFromSheets as any)({ data: { sheetIds: data.sheetIds } });
      } catch (e) {
        aggregates = { error: (e as Error).message };
      }
    }

    // 2) Pull FULL row sets per sheet (paginated) so FACTS are accurate
    //    even for very large sheets. Derive a smaller, evenly-strided sample
    //    for the LLM's qualitative context.
    const FULL_FETCH_CAP = 50000;
    const PAGE = 1000;
    const QUAL_SAMPLE_PER_SHEET = 220;
    const sources: { id: string; name: string; type: string; rowsTotal: number; rowsUsed: number; truncated: boolean }[] = [];
    const sampleRows: Array<{ sheet: string; type: string; row_index: number; data: Record<string, unknown> }> = [];
    const fullRowsBySheet = new Map<
      string,
      { label: string; type: string; rows: Array<{ row_index: number; data: Record<string, unknown> }> }
    >();

    // Tokenize the question for relevance scoring
    const STOP = new Set(["the","a","an","of","to","in","for","on","at","is","are","be","by","and","or","with","please","do","does","you","this","that"]);
    const qTokens = Array.from(
      new Set(
        data.question
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t && (/[0-9]/.test(t) ? t.length >= 1 : t.length >= 2 && !STOP.has(t))),
      ),
    );

    const fetchStoredRows = async (registryId: string, fetchTarget: number) => {
      const allRows: { row_index: number; canonical: any; extras: any }[] = [];
      for (let offset = 0; offset < fetchTarget; offset += PAGE) {
        const { data: pageRows } = await supabase
          .from("sheet_rows")
          .select("row_index, canonical, extras")
          .eq("sheet_registry_id", registryId)
          .order("row_index", { ascending: true })
          .range(offset, Math.min(offset + PAGE - 1, fetchTarget - 1));
        if (!pageRows?.length) break;
        allRows.push(...pageRows);
      }
      return allRows;
    };

    for (const r of regs) {
      let { count } = await supabase
        .from("sheet_rows")
        .select("row_index", { count: "exact", head: true })
        .eq("sheet_registry_id", r.id);
      let total = count ?? 0;
      let fetchTarget = Math.min(total, FULL_FETCH_CAP);
      let allRows = await fetchStoredRows(r.id, fetchTarget);

      // If an older import used numeric totals or A/B/C letters as headers,
      // repair it on demand before answering so Copilot can see real columns.
      if (storedRowsLookMisread(allRows.slice(0, 12))) {
        await syncRowsInternal(supabase, userId, r.id);
        const recount = await supabase
          .from("sheet_rows")
          .select("row_index", { count: "exact", head: true })
          .eq("sheet_registry_id", r.id);
        count = recount.count;
        total = count ?? 0;
        fetchTarget = Math.min(total, FULL_FETCH_CAP);
        allRows = await fetchStoredRows(r.id, fetchTarget);
      }

      sources.push({
        id: r.id,
        name: r.display_name,
        type: r.sheet_type,
        rowsTotal: total,
        rowsUsed: allRows.length,
        truncated: total > allRows.length,
      });
      const merged = allRows.map(mergedSheetRow);
      fullRowsBySheet.set(r.id, {
        label: r.display_name,
        type: r.sheet_type,
        rows: allRows.map((row, i) => ({ row_index: row.row_index, data: merged[i] })),
      });

      // Question-relevant sampling: score each row by how many question tokens
      // appear in its values. Keep top-N. Falls back to even-stride if zero hits.
      type Scored = { idx: number; score: number };
      const scored: Scored[] = [];
      if (qTokens.length > 0) {
        for (let i = 0; i < allRows.length; i++) {
          const hay = JSON.stringify(merged[i]).toLowerCase();
          let s = 0;
          for (const t of qTokens) if (hay.includes(t)) s++;
          if (s > 0) scored.push({ idx: i, score: s });
        }
        scored.sort((a, b) => b.score - a.score);
      }
      const picked = new Set<number>();
      for (const s of scored.slice(0, QUAL_SAMPLE_PER_SHEET)) picked.add(s.idx);
      // top-up with stride samples for breadth
      if (picked.size < QUAL_SAMPLE_PER_SHEET && allRows.length > 0) {
        const need = QUAL_SAMPLE_PER_SHEET - picked.size;
        const stride = Math.max(1, Math.floor(allRows.length / Math.max(1, need)));
        for (let i = 0; i < allRows.length && picked.size < QUAL_SAMPLE_PER_SHEET; i += stride) picked.add(i);
      }
      for (const i of Array.from(picked).sort((a, b) => a - b)) {
        sampleRows.push({
          sheet: r.display_name,
          type: r.sheet_type,
          row_index: allRows[i].row_index,
          data: merged[i],
        });
      }
    }

    // ---- Question-relevant FILTERED FACTS over FULL rows ----
    // For each sheet, find columns whose values contain any question token,
    // then compute exact counts per matching value. These are authoritative.
    const filteredFactsBlocks: string[] = [];
    const relevantRowBlocks: string[] = [];
    if (qTokens.length > 0) {
      for (const grp of fullRowsBySheet.values()) {
        const hits: string[] = [];
        const relevantRows: Array<{ row_index: number; matched_tokens: string[]; data: Record<string, unknown> }> = [];
        const columns = Array.from(
          grp.rows.reduce((s, r) => {
            Object.keys(r.data).forEach((k) => s.add(k));
            return s;
          }, new Set<string>()),
        );
        for (const col of columns) {
          // For each question token, count rows where col value contains the token.
          const perToken = new Map<string, number>();
          for (const row of grp.rows) {
            const v = row.data[col];
            if (v == null) continue;
            const sv = String(v).toLowerCase();
            if (!sv) continue;
            for (const t of qTokens) {
              if (sv.includes(t)) perToken.set(t, (perToken.get(t) ?? 0) + 1);
            }
          }
          for (const [t, n] of perToken) {
            if (n > 0) hits.push(`  • ${col} contains "${t}" → ${n} row${n === 1 ? "" : "s"}`);
          }
        }
        if (hits.length > 0) {
          // Cap to avoid prompt bloat
          filteredFactsBlocks.push(
            `Sheet "${grp.label}" — question-token row counts (FULL DATASET):\n` +
              hits.slice(0, 60).join("\n"),
          );
        }
        for (let i = 0; i < grp.rows.length; i++) {
          const hay = normalizeSearchText(Object.values(grp.rows[i].data).join(" "));
          const matched = qTokens.filter((t) => hay.includes(t));
          if (matched.length > 0) {
            relevantRows.push({ row_index: grp.rows[i].row_index, matched_tokens: matched, data: grp.rows[i].data });
          }
        }
        relevantRows.sort((a, b) => {
          const diff = b.matched_tokens.length - a.matched_tokens.length;
          if (diff !== 0) return diff;
          return a.row_index - b.row_index;
        });
        if (relevantRows.length > 0) {
          relevantRowBlocks.push(
            `Sheet "${grp.label}" — top query-matching rows from FULL DATASET:\n` +
              JSON.stringify(relevantRows.slice(0, 80)),
          );
        }
      }
    }

    // 3) Document context: pull summaries + key points for selected documents.
    const documentContext: Array<{ id: string; name: string; summary: string | null; key_points: unknown }> = [];
    if (data.documentIds.length > 0) {
      const { data: docs, error: dErr } = await supabase
        .from("documents")
        .select("id,name,summary,key_points")
        .in("id", data.documentIds);
      if (dErr) throw new Error(dErr.message);
      for (const d of docs ?? []) {
        documentContext.push({
          id: d.id,
          name: d.name,
          summary: d.summary,
          key_points: d.key_points,
        });
        sources.push({
          id: d.id,
          name: d.name,
          type: "document",
          rowsTotal: 0,
          rowsUsed: 0,
          truncated: false,
        });
      }
    }

    // ---- Precomputed FACTS per selected sheet (authoritative; over FULL rows) ----
    const { inferColumnStats, fmtNumber } = await import("./notebook/compute");
    const factsBlocks: string[] = [];
    for (const grp of fullRowsBySheet.values()) {
      const columns = Array.from(
        grp.rows.reduce((s, r) => {
            Object.keys(r.data).forEach((k) => s.add(k));
          return s;
        }, new Set<string>()),
      );
      const stats = inferColumnStats({ label: grp.label, columns, rows: grp.rows.map((r) => r.data) });
      const lines: string[] = [`Sheet "${grp.label}" (${grp.type}) — ${grp.rows.length} rows (FULL DATASET)`];
      for (const st of stats) {
        if (st.type === "number") {
          lines.push(
            `  • ${st.column} [number] sum=${fmtNumber(st.sum ?? 0)} avg=${fmtNumber(st.avg ?? 0)} min=${fmtNumber(st.min ?? 0)} max=${fmtNumber(st.max ?? 0)} nonEmpty=${st.nonEmpty}`,
          );
        } else if (st.type === "categorical" && st.topValues?.length) {
          const top = st.topValues.map((v) => `${v.value}=${v.count}`).join(", ");
          lines.push(`  • ${st.column} [categorical] distinct=${st.distinct} {${top}}`);
        } else if (st.type === "date") {
          lines.push(`  • ${st.column} [date] nonEmpty=${st.nonEmpty}`);
        } else {
          lines.push(`  • ${st.column} [text] nonEmpty=${st.nonEmpty}`);
        }
      }
      factsBlocks.push(lines.join("\n"));
    }

    // ===== OPERATIONS LAYER =====
    // 1) Heuristic ranks (always-on) over numeric-measure-ish columns.
    const operationBlocks: string[] = [];
    for (const grp of fullRowsBySheet.values()) {
      const ranks = buildHeuristicRanks(grp);
      if (ranks.length > 0) {
        operationBlocks.push(
          `Sheet "${grp.label}" — heuristic ranks (FULL DATASET):\n${JSON.stringify(ranks).slice(0, 6000)}`,
        );
      }
    }

    // 2) AI-planned operations executed deterministically.
    const lovableKeyEarly = process.env.LOVABLE_API_KEY;
    const geminiKeyEarly = process.env.GEMINI_API_KEY;
    if ((lovableKeyEarly || geminiKeyEarly) && fullRowsBySheet.size > 0) {
      const catalog = Array.from(fullRowsBySheet.values()).map((g) => {
        const cols = Array.from(g.rows.reduce((s, r) => { Object.keys(r.data).forEach((k) => s.add(k)); return s; }, new Set<string>()));
        const sample = g.rows.slice(0, 3).map((r) => r.data);
        return { sheet: g.label, columns: cols, sample };
      });
      const plannerSys =
        "You are an analytics PLANNER. Output STRICT JSON ONLY. Never output numeric results.\n" +
        "Decide which operations answer the user's question over the given sheets. Use ONLY column names listed.\n" +
        "Schema: {\"operations\":[{\"sheet\":\"<label>\",\"op\":\"top_n|bottom_n|group_by|filter_sort|aggregate|distribution|none\",\"measure\":\"<col>|null\",\"agg\":\"sum|avg|count|min|max|null\",\"dimension\":\"<col>|null\",\"filter\":[{\"column\":\"<col>\",\"op\":\"eq|contains|gt|gte|lt|lte\",\"value\":<any>}],\"sort_by\":\"<col>|null\",\"sort_dir\":\"asc|desc\",\"n\":<int>}]}\n" +
        "If question is not analytical, return {\"operations\":[]}. Pick one or two operations max.";
      const plannerUser = `QUESTION: ${data.question}\n\nSHEETS:\n${JSON.stringify(catalog).slice(0, 18000)}`;

      try {
        let planText = "";
        if (lovableKeyEarly) {
          const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Lovable-API-Key": lovableKeyEarly },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [{ role: "system", content: plannerSys }, { role: "user", content: plannerUser }],
              temperature: 0,
              response_format: { type: "json_object" },
            }),
          });
          if (res.ok) {
            const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
            planText = j.choices?.[0]?.message?.content ?? "";
          }
        }
        if (planText) {
          const fenced = planText.match(/```(?:json)?\s*([\s\S]*?)```/i);
          const txt = (fenced ? fenced[1] : planText).trim();
          const first = txt.indexOf("{"); const last = txt.lastIndexOf("}");
          const jsonStr = first >= 0 && last > first ? txt.slice(first, last + 1) : txt;
          const plan = JSON.parse(jsonStr) as { operations?: OpSpec[] };
          for (const spec of plan.operations ?? []) {
            const target = Array.from(fullRowsBySheet.values()).find((g) => g.label === spec.sheet) ?? Array.from(fullRowsBySheet.values())[0];
            if (!target) continue;
            const out = executeOperation(spec, target);
            if (out) {
              operationBlocks.push(
                `Sheet "${target.label}" — planned op:\n${JSON.stringify({ spec: out.spec, resolved: out.resolved, result: out.result }).slice(0, 12000)}`,
              );
            }
          }
        }
      } catch (e) {
        console.warn("Planner skipped:", (e as Error).message);
      }
    }

    // Pull document RAG chunks for selected documents (best-effort).
    let docChunkBlocks: string[] = [];
    if (data.documentIds.length > 0) {
      try {
        const { embedTexts, toPgVector } = await import("./documents.server");
        const [qVec] = await embedTexts([data.question]);
        for (const docId of data.documentIds) {
          const { data: matches } = await (supabase as any).rpc("match_doc_chunks", {
            _user_id: userId,
            _query: toPgVector(qVec),
            _scope_folder: null,
            _scope_document: docId,
            _match_count: 16,
          });
          for (const m of (matches ?? []) as any[]) {
            docChunkBlocks.push(
              `[${m.document_name}${m.page_no ? ` p.${m.page_no}` : ""}]\n${m.content}`,
            );
          }
        }
      } catch (e) {
        console.warn("Copilot RAG fallback:", (e as Error).message);
      }
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const lovableKey = process.env.LOVABLE_API_KEY;

    let answer: string = "";
    if (!geminiKey && !lovableKey) {
      answer = "AI isn't configured for this workspace yet.";
    } else {
      const docSummariesBlock = documentContext
        .map(
          (d) =>
            `Document: ${d.name}\nSummary: ${d.summary ?? "(none)"}\nKey points: ${
              Array.isArray(d.key_points) ? (d.key_points as unknown[]).join("; ") : ""
            }`,
        )
        .join("\n\n");

      const factsText = factsBlocks.length ? factsBlocks.join("\n\n") : "(no sheets in scope)";
      const filteredFactsText = filteredFactsBlocks.length ? filteredFactsBlocks.join("\n\n") : "";
      const relevantRowsText = relevantRowBlocks.length ? relevantRowBlocks.join("\n\n").slice(0, 90000) : "";
      const rowsBlock = sampleRows.length
        ? JSON.stringify(sampleRows.slice(0, 400)).slice(0, 80000)
        : "(no sheet rows in scope)";
      const aggBlock = aggregates ? JSON.stringify(aggregates).slice(0, 8000) : "";
      const opsText = operationBlocks.length ? operationBlocks.join("\n\n").slice(0, 30000) : "";
      const chunksBlock = docChunkBlocks.length
        ? docChunkBlocks.join("\n\n---\n\n").slice(0, 80000)
        : "(no document excerpts retrieved)";

      const multiSheet = regs.length > 1;
      const multiSheetRules = multiSheet
        ? "\nMULTI-SHEET MODE — you have " + regs.length + " sheets in context (" + regs.map((r) => `"${r.display_name}"`).join(", ") + "). Structure your answer EXACTLY as:\n" +
          "## Combined Answer\n" +
          "One synthesised, DEDUPLICATED response that merges findings across all sheets. Call out overlaps (same entity appearing in multiple sheets — match by name/ID/code) and reconcile conflicting numbers. Do not repeat the same fact twice.\n" +
          "## Per-Sheet Breakdown\n" +
          "Then one `### <sheet name>` subsection per sheet with that sheet's specific answer (or 'No relevant data' if empty). Keep each subsection short and grounded in that sheet's FACTS/OPERATION RESULTS.\n"
        : "";
      const system =
        "You are a precise, sheet-aware analyst (NotebookLM-style). Each sheet has its OWN columns and meaning — adapt your answer to what FACTS and OPERATION RESULTS actually contain.\n" +
        multiSheetRules +
        "RULES:\n" +
        "1) NUMBERS are authoritative: any count, sum, average, min, max, ranking, top-N, bottom-N, group-by, or distribution MUST be quoted VERBATIM from OPERATION RESULTS, FACTS, QUERY-RELEVANT FACTS, AGGREGATES, or QUERY-MATCHING ROWS. NEVER calculate, estimate, or invent numbers yourself.\n" +
        "2) For ranking/top/bottom/highest/lowest/most/least/sort/'by X'/'per Y' questions, the answer MUST be built from OPERATION RESULTS. If OPERATION RESULTS is empty for that question, say what's missing and offer the closest available view from FACTS.\n" +
        "3) DO NOT invent fields. Only mention columns/categories that appear in FACTS or OPERATION RESULTS for the sheet you're answering about. NEVER output a Delayed / Blocked / Completed / At Risk / Risk Score template unless an AGGREGATES block is provided with non-trivial values — those concepts only exist for delay/progress sheets.\n" +
        "4) For a 'summary' or 'overview' question, describe the sheet using its actual columns: total row count (from FACTS), key columns, top categorical values, and headline numeric stats — all verbatim from FACTS.\n" +
        "5) For lookup questions about a specific store, item code, project, person, ID, date, status, or exact value, use QUERY-MATCHING ROWS first (selected from the FULL dataset).\n" +
        "6) The ROW SAMPLE is for extra examples only — prefer OPERATION RESULTS / QUERY-MATCHING ROWS / FACTS.\n" +
        "7) For document questions, answer ONLY from DOCUMENT EXCERPTS or SUMMARIES; quote short phrases and cite the document name (and page when shown).\n" +
        "8) If the answer isn't in the provided context, say so plainly.\n" +
        "9) Cite source names in parentheses, e.g. (Sheet A row 42) or (contract.pdf p.4). Use markdown — bullets, short tables, **bold key values**.";

      const historyBlock =
        data.history.length > 0
          ? data.history
              .slice(-8)
              .map((m) => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content.slice(0, 2000)}`)
              .join("\n\n")
          : "";

      const userMsg =
        (historyBlock
          ? `PRIOR CONVERSATION (most-recent last — resolve pronouns/follow-ups using this, but ground every fact in the data below):\n${historyBlock}\n\n`
          : "") +
        `QUESTION: ${data.question}\n\n` +
        (opsText ? `OPERATION RESULTS (authoritative, computed deterministically over FULL rows — use these verbatim for ranking/aggregation/group-by answers):\n${opsText}\n\n` : "") +
        `FACTS (authoritative, precomputed over FULL rows):\n${factsText}\n\n` +
        (filteredFactsText ? `QUERY-RELEVANT FACTS (FULL rows, exact):\n${filteredFactsText}\n\n` : "") +
        (relevantRowsText ? `QUERY-MATCHING ROWS (FULL rows, exact row data):\n${relevantRowsText}\n\n` : "") +
        (aggBlock ? `AGGREGATES:\n${aggBlock}\n\n` : "") +
        `SHEET ROW SAMPLE (JSON, prioritised by relevance to the question):\n${rowsBlock}\n\n` +
        (docSummariesBlock ? `DOCUMENT SUMMARIES:\n${docSummariesBlock}\n\n` : "") +
        `DOCUMENT EXCERPTS (top-matched chunks for this question):\n${chunksBlock}`;



      const callGemini = async (model: string) => {
        return await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: userMsg }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
            }),
          },
        );
      };

      const callLovable = async () => {
        return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Lovable-API-Key": lovableKey! },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: system },
              { role: "user", content: userMsg },
            ],
          }),
        });
      };

      const parseGemini = async (res: Response) => {
        const j = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        return (
          j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ||
          "(empty response)"
        );
      };
      const parseLovable = async (res: Response) => {
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return j.choices?.[0]?.message?.content?.trim() ?? "(empty response)";
      };

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      let lastErr = "";
      if (geminiKey) {
        const models = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"];
        outer: for (const m of models) {
          for (let attempt = 0; attempt < 2; attempt++) {
            const res = await callGemini(m);
            if (res.ok) {
              answer = await parseGemini(res);
              lastErr = "";
              break outer;
            }
            lastErr = `Gemini ${m} (${res.status})`;
            // Only retry on transient errors; otherwise move on to next model
            if (res.status !== 503 && res.status !== 429 && res.status !== 500) break;
            await sleep(700 * (attempt + 1));
          }
        }
      }

      if (!answer && lovableKey) {
        const res = await callLovable();
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          if (res.status === 429) throw new Error("AI rate limit exceeded — please retry shortly.");
          if (res.status === 402) throw new Error("AI credits exhausted for this workspace.");
          throw new Error(`AI error (${res.status}): ${t.slice(0, 300)}`);
        }
        answer = await parseLovable(res);
      }

      if (!answer) {
        throw new Error(
          `AI is temporarily unavailable (${lastErr || "no provider"}). Please retry in a moment.`,
        );
      }

    }

    // Persist the exchange
    await supabase.from("copilot_messages").insert([
      {
        user_id: userId,
        role: "user",
        content: data.question,
        scope: { sheetIds: data.sheetIds, documentIds: data.documentIds },
      },
      {
        user_id: userId,
        role: "assistant",
        content: answer,
        scope: { sheetIds: data.sheetIds, documentIds: data.documentIds },
        citations: sources,
      },
    ]);

    // Generate 3 short follow-up suggestions (best-effort, never blocks the answer)
    let suggestions: string[] = [];
    try {
      const sugPrompt =
        `Based on this user question and the analyst's answer, propose exactly 3 short, specific follow-up questions the user is likely to ask next. ` +
        `Each must be answerable from the same data scope. Output ONLY a JSON array of 3 strings, no prose.\n\n` +
        `QUESTION: ${data.question}\n\nANSWER: ${answer.slice(0, 4000)}`;
      if (geminiKey) {
        const sres = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: sugPrompt }] }],
              generationConfig: { temperature: 0.5, maxOutputTokens: 400, responseMimeType: "application/json" },
            }),
          },
        );
        if (sres.ok) {
          const sj = (await sres.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const raw = sj.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            suggestions = parsed.filter((s) => typeof s === "string").slice(0, 3);
          }
        }
      }
    } catch {
      suggestions = [];
    }

    return { answer, sources, suggestions };
  });

// ============================================================================
// Auto-Insights digest: proactive "things you should know" per sheet
// ============================================================================
export const generateAutoInsights = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sheetId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .select("id, display_name, sheet_type")
      .eq("id", data.sheetId)
      .eq("user_id", userId)
      .maybeSingle();
    if (regErr) throw new Error(regErr.message);
    if (!reg) throw new Error("Sheet not found");

    // Reuse askCopilot with a curated prompt to keep the answer grounded.
    const out = await (askCopilot as any)({
      data: {
        question:
          "Give me an Auto-Insights digest: 5 to 7 short, surprising or important findings from this sheet — anomalies, outliers, top movers, concentrations, risk signals, or noteworthy trends. " +
          "Output ONLY a JSON array of objects with shape {\"title\":string,\"detail\":string,\"severity\":\"info\"|\"warning\"|\"critical\"}. Each title <= 60 chars, each detail 1-2 sentences with at least one specific number from the data. No prose outside the JSON.",
        sheetIds: [data.sheetId],
        documentIds: [],
        history: [],
      },
    });

    let insights: { title: string; detail: string; severity: "info" | "warning" | "critical" }[] = [];
    try {
      const text = (out.answer as string).trim();
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (Array.isArray(parsed)) {
          insights = parsed
            .filter(
              (i: unknown): i is { title: string; detail: string; severity?: string } =>
                !!i && typeof (i as any).title === "string" && typeof (i as any).detail === "string",
            )
            .map((i) => ({
              title: i.title.slice(0, 100),
              detail: i.detail.slice(0, 400),
              severity: (i.severity === "critical" || i.severity === "warning"
                ? i.severity
                : "info") as "info" | "warning" | "critical",
            }))

            .slice(0, 7);
        }
      }
    } catch {
      insights = [];
    }

    return { sheetId: reg.id, sheetName: reg.display_name, insights };
  });

// ============================================================================
// generateChart — AI plans a chart spec, server executes deterministically,
// returns chart-ready data per selected sheet for client rendering.
// ============================================================================
export const generateChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        question: z.string().min(1).max(2000),
        sheetIds: z.array(z.string().uuid()).min(1).max(5),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: regs, error } = await supabase
      .from("sheet_registry")
      .select("id, display_name, sheet_type")
      .in("id", data.sheetIds)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);

    const FETCH_CAP = 50000;
    const PAGE = 1000;
    const fetchAll = async (id: string, target: number) => {
      const out: { row_index: number; canonical: any; extras: any }[] = [];
      for (let off = 0; off < target; off += PAGE) {
        const { data: page } = await supabase
          .from("sheet_rows")
          .select("row_index, canonical, extras")
          .eq("sheet_registry_id", id)
          .order("row_index", { ascending: true })
          .range(off, Math.min(off + PAGE - 1, target - 1));
        if (!page?.length) break;
        out.push(...page);
      }
      return out;
    };

    const lovableKey = process.env.LOVABLE_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!lovableKey && !geminiKey) {
      throw new Error("AI isn't configured for this workspace yet.");
    }

    const callPlanner = async (sys: string, user: string): Promise<string> => {
      if (lovableKey) {
        const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Lovable-API-Key": lovableKey },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
            temperature: 0,
            response_format: { type: "json_object" },
          }),
        });
        if (res.ok) {
          const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          return j.choices?.[0]?.message?.content ?? "";
        }
      }
      if (geminiKey) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: sys }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 800,
                responseMimeType: "application/json",
              },
            }),
          },
        );
        if (res.ok) {
          const j = (await res.json()) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        }
      }
      return "";
    };

    type ChartSpec = {
      chart_type?: "bar" | "line" | "pie";
      title?: string;
      op?: "top_n" | "bottom_n" | "group_by" | "distribution";
      dimension?: string | null;
      measure?: string | null;
      agg?: "sum" | "avg" | "count" | "min" | "max" | null;
      sort_dir?: "asc" | "desc";
      n?: number;
    };

    const charts: Array<{
      sheetId: string;
      sheet: string;
      chartType: "bar" | "line" | "pie";
      title: string;
      xKey: string;
      yKey: string;
      data: Array<{ name: string; value: number }>;
    }> = [];
    const skipped: Array<{ sheet: string; reason: string }> = [];

    for (const r of regs ?? []) {
      const { count } = await supabase
        .from("sheet_rows")
        .select("row_index", { count: "exact", head: true })
        .eq("sheet_registry_id", r.id);
      const total = count ?? 0;
      if (!total) {
        skipped.push({ sheet: r.display_name, reason: "no rows" });
        continue;
      }
      let raw = await fetchAll(r.id, Math.min(total, FETCH_CAP));
      if (storedRowsLookMisread(raw.slice(0, 12))) {
        await syncRowsInternal(supabase, userId, r.id);
        raw = await fetchAll(r.id, Math.min(total, FETCH_CAP));
      }
      const merged = raw.map(mergedSheetRow);
      const group = {
        label: r.display_name,
        rows: raw.map((row, i) => ({ row_index: row.row_index, data: merged[i] })),
      };
      const columns = Array.from(
        group.rows.reduce((s, row) => {
          Object.keys(row.data).forEach((k) => s.add(k));
          return s;
        }, new Set<string>()),
      );

      const sys =
        "You are a CHART PLANNER. Output STRICT JSON ONLY matching this schema:\n" +
        '{"chart_type":"bar|line|pie","title":"<short>","op":"top_n|bottom_n|group_by|distribution","dimension":"<col>","measure":"<col>|null","agg":"sum|avg|count|min|max|null","sort_dir":"asc|desc","n":<int 5-20>}\n' +
        "Rules: use ONLY listed columns. chart_type=pie for small categorical distributions (<=8 slices). line when dimension is a date/time/period. bar otherwise. If measure is null, agg defaults to count. Never invent columns.";
      const usr = `QUESTION: ${data.question}\nSHEET: ${r.display_name}\nCOLUMNS: ${JSON.stringify(columns)}\nSAMPLE: ${JSON.stringify(group.rows.slice(0, 3).map((x) => x.data))}`;

      let spec: ChartSpec | null = null;
      try {
        const text = await callPlanner(sys, usr);
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        const t = (fenced ? fenced[1] : text).trim();
        const first = t.indexOf("{");
        const last = t.lastIndexOf("}");
        spec = JSON.parse(first >= 0 && last > first ? t.slice(first, last + 1) : t) as ChartSpec;
      } catch (e) {
        skipped.push({ sheet: r.display_name, reason: "planner failed" });
        continue;
      }

      if (!spec || !spec.op) {
        skipped.push({ sheet: r.display_name, reason: "no chart spec" });
        continue;
      }

      const out = executeOperation(
        {
          op: spec.op,
          dimension: spec.dimension ?? null,
          measure: spec.measure ?? null,
          agg: spec.agg ?? null,
          sort_dir: spec.sort_dir ?? "desc",
          n: spec.n ?? 12,
        },
        group,
      );
      if (!out || !Array.isArray(out.result)) {
        skipped.push({ sheet: r.display_name, reason: "operation returned nothing" });
        continue;
      }

      const xKey = out.resolved.dimension ?? "name";
      const points = (out.result as Record<string, unknown>[])
        .map((row) => {
          const yKey =
            Object.keys(row).find(
              (k) => k !== xKey && k !== "row_index" && typeof row[k] === "number",
            ) ?? "count";
          const v = Number(row[yKey] ?? 0);
          return {
            name: String(row[xKey] ?? "(blank)").slice(0, 40),
            value: Number.isFinite(v) ? Math.round(v * 100) / 100 : 0,
          };
        })
        .slice(0, Math.min(spec.n ?? 20, 30));

      if (points.length === 0) {
        skipped.push({ sheet: r.display_name, reason: "no datapoints" });
        continue;
      }

      charts.push({
        sheetId: r.id,
        sheet: r.display_name,
        chartType: (spec.chart_type ?? "bar") as "bar" | "line" | "pie",
        title: spec.title?.slice(0, 80) ?? `${r.display_name} — chart`,
        xKey,
        yKey: "value",
        data: points,
      });
    }

    return { charts, skipped };
  });


// ----- Sheet sharing / visibility -------------------------------------------

export const getSheetShares = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ registryId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
    if (!isAdmin) throw new Error("Only admins can view shares");
    const { data: rows, error } = await supabase
      .from("sheet_registry_shares")
      .select("user_id")
      .eq("sheet_registry_id", data.registryId);
    if (error) throw new Error(error.message);
    return { user_ids: (rows ?? []).map((r: any) => r.user_id as string) };
  });

export const updateSheetVisibility = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        registryId: z.string().uuid(),
        visibility: z.enum(["private", "public", "shared"]),
        sharedUserIds: z.array(z.string().uuid()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
    if (!isAdmin) throw new Error("Only admins can change visibility");

    const { error: uerr } = await supabase
      .from("sheet_registry")
      .update({ visibility: data.visibility })
      .eq("id", data.registryId);
    if (uerr) throw new Error(uerr.message);

    await supabase.from("sheet_registry_shares").delete().eq("sheet_registry_id", data.registryId);
    if (data.visibility === "shared") {
      const ids = Array.from(new Set(data.sharedUserIds ?? []));
      if (ids.length > 0) {
        const { error: ierr } = await supabase.from("sheet_registry_shares").insert(
          ids.map((uid) => ({
            sheet_registry_id: data.registryId,
            user_id: uid,
            created_by: userId,
          })),
        );
        if (ierr) throw new Error(ierr.message);
      }
    }
    return { ok: true };
  });
