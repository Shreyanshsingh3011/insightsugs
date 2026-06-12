import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";
import { callEmergent } from "@/lib/emergent-client";


const SHEET_TYPE_ENUM = z.enum([
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

  // Try JSON first when the server claims JSON or the body looks JSON-y
  const looksJson = ctype.includes("json") || /^\s*[\[{]/.test(body);
  if (looksJson) {
    try {
      const payload = JSON.parse(body);
      const normalized = normalizeAppsScriptPayload(payload);
      if (normalized.headers.length > 0) return normalized;
    } catch {
      /* fall through to CSV */
    }
  }

  // CSV fallback (Google Sheets export, Excel CSV, generic CSV)
  if (ctype.includes("csv") || ctype.includes("text/plain") || /,|\n/.test(body)) {
    const csv = parseCsv(body);
    if (csv.headers.length > 0) return csv;
  }

  throw new Error(
    "Couldn't read tabular data from this URL. Provide a JSON endpoint (with rows/headers/values or an array of objects), a Google Sheets share link, or a direct CSV URL.",
  );
}

async function proposeMapping(
  sheetType: SheetType,
  headers: string[],
  sampleRows: string[][],
): Promise<Record<string, string | null>> {
  const canonical = CANONICAL_FIELDS[sheetType];
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
      const hit =
        canonical.find((c) => norm(c) === hn) ??
        canonical.find((c) => hn.includes(norm(c)) || norm(c).includes(hn));
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
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .insert({
        user_id: userId,
        sheet_type: data.sheetType,
        apps_script_url: data.appsScriptUrl,
        display_name: data.displayName,
      })
      .select("id")
      .single();
    if (regErr) throw new Error(regErr.message);
    const registryId = reg.id as string;

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
    const { data, error } = await supabase
      .from("sheet_registry")
      .select(
        "id, sheet_type, display_name, apps_script_url, source_url, row_count, last_refreshed_at, created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { sheets: data ?? [] };
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

    // sheets owned by the user (registry is per-owner)
    const { data: regs } = await supabase
      .from("sheet_registry")
      .select("id, display_name")
      .eq("user_id", userId);
    const regIds = (regs ?? []).map((r) => r.id as string);
    if (regIds.length === 0) return { rows: [] };

    const regName = new Map((regs ?? []).map((r) => [r.id as string, r.display_name as string]));

    const { data: rows } = await supabase
      .from("sheet_rows")
      .select("sheet_registry_id, row_index, canonical, extras")
      .in("sheet_registry_id", regIds)
      .limit(10000);

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
  .inputValidator((input: unknown) => z.object({ registryId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .select(
        "id, sheet_type, display_name, apps_script_url, row_count, last_refreshed_at",
      )
      .eq("id", data.registryId)
      .eq("user_id", userId)
      .maybeSingle();
    if (regErr) throw new Error(regErr.message);
    if (!reg) throw new Error("Sheet not found.");

    const { data: maps } = await supabase
      .from("sheet_column_mappings")
      .select("source_header, canonical_field, position")
      .eq("sheet_registry_id", data.registryId)
      .order("position", { ascending: true });

    const { data: rows } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", data.registryId)
      .order("row_index", { ascending: true })
      .limit(500);

    return { registry: reg, mappings: maps ?? [], rows: rows ?? [] };
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
export const askCopilot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        question: z.string().min(1).max(2000),
        sheetIds: z.array(z.string().uuid()).max(10).default([]),
        documentIds: z.array(z.string().uuid()).max(10).default([]),
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
    //    Re-use buildDashboardFromSheets so Copilot sees the same shape as the UI.
    let aggregates: unknown = null;
    if (data.sheetIds.length > 0) {
      const { buildDashboardFromSheets } = await import("./dashboard.functions");
      try {
        aggregates = await (buildDashboardFromSheets as any)({ data: { sheetIds: data.sheetIds } });
      } catch (e) {
        aggregates = { error: (e as Error).message };
      }
    }

    // 2) Row sample for row-level questions. Cap and report the cap honestly.
    const PER_SHEET_SAMPLE = 1000;
    const sources: { id: string; name: string; type: string; rowsTotal: number; rowsUsed: number; truncated: boolean }[] = [];
    const sampleRows: Array<{ sheet: string; type: string; row_index: number; data: Record<string, unknown> }> = [];

    for (const r of regs) {
      const { count } = await supabase
        .from("sheet_rows")
        .select("row_index", { count: "exact", head: true })
        .eq("sheet_registry_id", r.id);
      const { data: rows } = await supabase
        .from("sheet_rows")
        .select("row_index, canonical, extras")
        .eq("sheet_registry_id", r.id)
        .order("row_index", { ascending: true })
        .limit(PER_SHEET_SAMPLE);
      const slice = rows ?? [];
      const total = count ?? slice.length;
      sources.push({
        id: r.id,
        name: r.display_name,
        type: r.sheet_type,
        rowsTotal: total,
        rowsUsed: slice.length,
        truncated: total > slice.length,
      });
      for (const row of slice) {
        sampleRows.push({
          sheet: r.display_name,
          type: r.sheet_type,
          row_index: row.row_index,
          data: { ...((row.canonical as Record<string, unknown>) ?? {}), ...((row.extras as Record<string, unknown>) ?? {}) },
        });
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

    // Build context for Lovable AI. We answer directly so Copilot works
    // regardless of whether the optional Emergent integration is configured.
    const lovableKey = process.env.LOVABLE_API_KEY;

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
            _match_count: 6,
          });
          for (const m of (matches ?? []) as any[]) {
            docChunkBlocks.push(
              `[${m.document_name}${m.page_no ? ` p.${m.page_no}` : ""}]\n${m.content}`,
            );
          }
        }
      } catch (e) {
        // RAG is optional; continue with summaries only
        console.warn("Copilot RAG fallback:", (e as Error).message);
      }
    }

    let answer: string;
    if (!lovableKey) {
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

      const rowsBlock = sampleRows.length
        ? JSON.stringify(sampleRows.slice(0, 400))
        : "(no sheet rows in scope)";

      const aggBlock = aggregates ? JSON.stringify(aggregates).slice(0, 8000) : "";

      const chunksBlock = docChunkBlocks.length
        ? docChunkBlocks.join("\n\n---\n\n")
        : "(no document excerpts retrieved)";

      const system =
        "You are a helpful analyst answering questions about the user's sheets and documents. " +
        "Use ONLY the provided context. If the answer isn't in the context, say you don't know. " +
        "Cite source names in parentheses. Be concise and use markdown when helpful.";

      const userMsg =
        `QUESTION: ${data.question}\n\n` +
        (aggBlock ? `SHEET AGGREGATES:\n${aggBlock}\n\n` : "") +
        `SHEET ROW SAMPLE (JSON):\n${rowsBlock}\n\n` +
        (docSummariesBlock ? `DOCUMENT SUMMARIES:\n${docSummariesBlock}\n\n` : "") +
        `DOCUMENT EXCERPTS:\n${chunksBlock}`;

      try {
        const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": lovableKey,
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: system },
              { role: "user", content: userMsg },
            ],
          }),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          if (res.status === 429) throw new Error("AI rate limit exceeded — please retry shortly.");
          if (res.status === 402) throw new Error("AI credits exhausted for this workspace.");
          throw new Error(`AI error (${res.status}): ${t.slice(0, 300)}`);
        }
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        answer = j.choices?.[0]?.message?.content?.trim() ?? "(empty response)";
      } catch (e) {
        throw e;
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

    return { answer, sources };
  });
