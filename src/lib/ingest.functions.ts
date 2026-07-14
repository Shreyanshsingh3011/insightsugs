import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";
import { withSchemaHeal } from "@/lib/schema-retry";

// Throw the Supabase error text so withSchemaHeal can detect PGRST002/205.
function must<T>(result: { data: T | null; error: { message?: string; code?: string } | null }): T {
  if (result.error) {
    const err = new Error(result.error.message ?? "Database error") as Error & { code?: string };
    err.code = result.error.code;
    throw err;
  }
  return result.data as T;
}

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

const VISIBILITY = z.enum(["private", "public", "shared"]);

// Heuristic column mapping — same shape as sheets.functions.proposeMapping's
// fallback path but inlined so this module has zero cross-imports and stays
// lightweight enough to lazy-load safely.
function heuristicMapping(sheetType: SheetType, headers: string[]) {
  const canonical = CANONICAL_FIELDS[sheetType];
  const result: Record<string, string | null> = {};
  if (canonical.length === 0) {
    for (const h of headers) result[h] = null;
    return result;
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
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

/**
 * Propose mapping for a client-parsed table (CSV/XLSX/pasted). No network
 * fetch — the client already has the headers/rows.
 */
export const proposeUploadMapping = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      sheetType: SHEET_TYPE_ENUM,
      headers: z.array(z.string()).min(1).max(200),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    return {
      proposedMapping: heuristicMapping(data.sheetType as SheetType, data.headers),
    };
  });

/**
 * Register a dataset from a client-parsed table. `source_kind` is encoded in
 * the apps_script_url as `upload://<uuid>` so refreshSheet can politely
 * reject and prompt for re-upload.
 */
export const ingestParsedTable = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      sheetType: SHEET_TYPE_ENUM,
      displayName: z.string().min(1).max(200),
      headers: z.array(z.string()).min(1).max(200),
      rows: z.array(z.array(z.string())).max(50_000),
      mapping: z.record(z.string(), z.string().nullable()).optional(),
      visibility: VISIBILITY.optional(),
      sharedUserIds: z.array(z.string().uuid()).optional(),
      sourceLabel: z.string().max(80).optional(), // "csv", "xlsx", "paste"
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Only admins may pick anything other than private.
    let visibility: "private" | "public" | "shared" = "private";
    if (data.visibility && data.visibility !== "private") {
      const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
      if (isAdmin) visibility = data.visibility;
    }
    const sharedIds =
      visibility === "shared" ? Array.from(new Set(data.sharedUserIds ?? [])) : [];

    const sentinel = `upload://${data.sourceLabel ?? "file"}/${crypto.randomUUID()}`;

    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .insert({
        user_id: userId,
        sheet_type: data.sheetType,
        apps_script_url: sentinel,
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

    const mapping = data.mapping ?? heuristicMapping(data.sheetType as SheetType, data.headers);
    const mappingRows = data.headers.map((h, idx) => ({
      sheet_registry_id: registryId,
      source_header: h,
      canonical_field: mapping[h] ?? null,
      position: idx,
    }));
    if (mappingRows.length > 0) {
      const { error: mapErr } = await supabase.from("sheet_column_mappings").insert(mappingRows);
      if (mapErr) throw new Error(mapErr.message);
    }

    // Convert parsed rows into canonical/extras split.
    const toInsert = data.rows.map((row, idx) => {
      const canonical: Record<string, string> = {};
      const extras: Record<string, string> = {};
      data.headers.forEach((h, i) => {
        if (!h) return;
        const cell = row[i] ?? "";
        const target = mapping[h];
        if (target) canonical[target] = cell;
        else extras[h] = cell;
      });
      return { sheet_registry_id: registryId, row_index: idx, canonical, extras };
    });

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

    return { id: registryId, rowCount: toInsert.length };
  });

/**
 * Replace rows for an existing uploaded dataset. Column mapping stays as-is.
 */
export const replaceUploadedRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      registryId: z.string().uuid(),
      headers: z.array(z.string()).min(1),
      rows: z.array(z.array(z.string())).max(50_000),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .select("id, user_id, apps_script_url")
      .eq("id", data.registryId)
      .maybeSingle();
    if (regErr) throw new Error(regErr.message);
    if (!reg || reg.user_id !== userId) throw new Error("Dataset not found.");
    if (!String(reg.apps_script_url ?? "").startsWith("upload://")) {
      throw new Error("This dataset came from a URL. Use Refresh instead.");
    }

    const { data: maps } = await supabase
      .from("sheet_column_mappings")
      .select("source_header, canonical_field")
      .eq("sheet_registry_id", data.registryId);
    const mapping: Record<string, string | null> = {};
    for (const m of maps ?? []) mapping[m.source_header] = m.canonical_field;

    const toInsert = data.rows.map((row, idx) => {
      const canonical: Record<string, string> = {};
      const extras: Record<string, string> = {};
      data.headers.forEach((h, i) => {
        if (!h) return;
        const cell = row[i] ?? "";
        const target = mapping[h];
        if (target) canonical[target] = cell;
        else extras[h] = cell;
      });
      return { sheet_registry_id: data.registryId, row_index: idx, canonical, extras };
    });

    const { error: delErr } = await supabase
      .from("sheet_rows")
      .delete()
      .eq("sheet_registry_id", data.registryId);
    if (delErr) throw new Error(delErr.message);

    if (toInsert.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const { error } = await supabase.from("sheet_rows").insert(toInsert.slice(i, i + BATCH));
        if (error) throw new Error(error.message);
      }
    }

    await supabase
      .from("sheet_registry")
      .update({
        last_refreshed_at: new Date().toISOString(),
        row_count: toInsert.length,
      })
      .eq("id", data.registryId);

    return { rowCount: toInsert.length };
  });
