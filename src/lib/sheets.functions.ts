import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  authorizeAppUserOAuth,
  callAsAppUser,
} from "@/integrations/lovable/appUserConnector";
import { CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";

const GATEWAY_BASE_URL = "https://connector-gateway.lovable.dev";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "openid",
  "email",
];

function requireGoogleClientId(): string {
  const id = process.env.GOOGLE_APP_USER_CONNECTOR_CLIENT_ID;
  if (!id) {
    throw new Error(
      "GOOGLE_APP_USER_CONNECTOR_CLIENT_ID is not set. Configure your Google OAuth client in project secrets.",
    );
  }
  return id;
}

// 1. Start Google OAuth for current user (popup, web_message flow)
export const startGoogleConnect = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ targetOrigin: z.string().url() }).parse(input))
  .handler(async ({ data, context }) => {
    const { authorizationUrl } = await authorizeAppUserOAuth({
      gatewayBaseUrl: GATEWAY_BASE_URL,
      connectorId: "google",
      appUserId: context.userId,
      connectorClientId: requireGoogleClientId(),
      returnUrl: data.targetOrigin,
      responseMode: "web_message",
      webMessageTargetOrigin: data.targetOrigin,
      credentialsConfiguration: { scopes: GOOGLE_SCOPES },
    });
    return { authorizationUrl };
  });

// 2. Persist the connection_id returned by the popup
export const saveGoogleConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      connectionId: z.string().min(1),
      googleEmail: z.string().email().optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("google_connections")
      .upsert(
        {
          user_id: userId,
          connection_id: data.connectionId,
          google_email: data.googleEmail ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// 3. Current connection status
export const getGoogleConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("google_connections")
      .select("connection_id, google_email, created_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data
      ? { connected: true as const, googleEmail: data.google_email, createdAt: data.created_at }
      : { connected: false as const };
  });

// 4. Disconnect (just removes the row; doesn't revoke at Google)
export const disconnectGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase.from("google_connections").delete().eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// 5. Inspect a sheet — fetch header row + sample rows + AI-propose mapping
async function getUserConnectionId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("google_connections")
    .select("connection_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.connection_id) throw new Error("Google account not connected.");
  return data.connection_id;
}

async function fetchSheetValues(connectionId: string, sheetId: string, range: string) {
  const res = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionId,
    connectorId: "google_sheets",
    path: `/v4/spreadsheets/${sheetId}/values/${range}`,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Sheets read failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<{ range: string; values?: string[][] }>;
}

async function fetchSheetMetadata(connectionId: string, sheetId: string) {
  const res = await callAsAppUser({
    gatewayBaseUrl: GATEWAY_BASE_URL,
    connectionId,
    connectorId: "google_sheets",
    path: `/v4/spreadsheets/${sheetId}?fields=properties.title,sheets.properties(title,sheetId)`,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Sheets metadata failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<{
    properties: { title: string };
    sheets: Array<{ properties: { title: string; sheetId: number } }>;
  }>;
}

async function proposeMapping(
  sheetType: SheetType,
  headers: string[],
  sampleRows: string[][],
): Promise<Record<string, string | null>> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

  const canonical = CANONICAL_FIELDS[sheetType];
  const prompt = `You are mapping spreadsheet column headers to a canonical schema.

Canonical fields for sheet type "${sheetType}":
${canonical.map((f) => `- ${f}`).join("\n")}

Source headers (in order):
${headers.map((h, i) => `${i}: ${JSON.stringify(h)}`).join("\n")}

Sample rows (first ${sampleRows.length}):
${sampleRows.map((r) => JSON.stringify(r)).join("\n")}

For EACH source header, return the best matching canonical field, or null if no match. Respond with ONLY a JSON object mapping source header -> canonical field name or null. No prose.`;

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Lovable-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AI mapping failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content ?? "{}";
  try {
    const parsed = JSON.parse(content);
    const result: Record<string, string | null> = {};
    for (const h of headers) {
      const v = parsed[h];
      result[h] = typeof v === "string" && canonical.includes(v) ? v : null;
    }
    return result;
  } catch {
    return Object.fromEntries(headers.map((h) => [h, null]));
  }
}

export const inspectSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      googleSheetId: z.string().min(10),
      sheetType: z.enum([
        "progress", "material_reconciliation", "procurement",
        "contractor_billing", "bill_tracking", "pms", "tat",
      ]),
      tabName: z.string().optional(),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const connectionId = await getUserConnectionId(supabase, userId);

    const meta = await fetchSheetMetadata(connectionId, data.googleSheetId);
    const tabName = data.tabName ?? meta.sheets[0]?.properties.title ?? "Sheet1";

    const range = `${tabName}!A1:Z6`;
    const values = await fetchSheetValues(connectionId, data.googleSheetId, encodeURIComponent(range));
    const rows = values.values ?? [];
    const headers = (rows[0] ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);
    const sampleRows = rows.slice(1);

    if (headers.length === 0) {
      throw new Error("No header row found in the first tab.");
    }

    const mapping = await proposeMapping(data.sheetType as SheetType, headers, sampleRows);

    return {
      spreadsheetTitle: meta.properties.title,
      tabName,
      headers,
      sampleRows,
      proposedMapping: mapping,
    };
  });

// 6. Save the registry entry + mapping, and immediately fetch all rows
export const registerAndSyncSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      googleSheetId: z.string().min(10),
      sheetType: z.enum([
        "progress", "material_reconciliation", "procurement",
        "contractor_billing", "bill_tracking", "pms", "tat",
      ]),
      tabName: z.string().min(1),
      displayName: z.string().min(1).max(200),
      mapping: z.record(z.string(), z.string().nullable()),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .insert({
        user_id: userId,
        sheet_type: data.sheetType,
        google_sheet_id: data.googleSheetId,
        tab_name: data.tabName,
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
    .select("google_sheet_id, tab_name, user_id")
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

  const connectionId = await getUserConnectionId(supabase, userId);
  const range = `${reg.tab_name}!A1:ZZ10000`;
  const values = await fetchSheetValues(connectionId, reg.google_sheet_id, encodeURIComponent(range));
  const allRows = values.values ?? [];
  if (allRows.length === 0) {
    await supabase.from("sheet_rows").delete().eq("sheet_registry_id", registryId);
    await supabase.from("sheet_registry").update({
      last_refreshed_at: new Date().toISOString(),
      row_count: 0,
    }).eq("id", registryId);
    return;
  }

  const headers = (allRows[0] ?? []).map((h) => String(h ?? "").trim());
  const dataRows = allRows.slice(1);

  const toInsert = dataRows.map((row, idx) => {
    const canonical: Record<string, string> = {};
    const extras: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = row[i] != null ? String(row[i]) : "";
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

  // Full-replace
  const { error: delErr } = await supabase
    .from("sheet_rows")
    .delete()
    .eq("sheet_registry_id", registryId);
  if (delErr) throw new Error(delErr.message);

  if (toInsert.length > 0) {
    // Batch to keep payloads sane
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
      .select("id, sheet_type, display_name, google_sheet_id, tab_name, row_count, last_refreshed_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { sheets: data ?? [] };
  });

export const getSheetDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ registryId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: reg, error: regErr } = await supabase
      .from("sheet_registry")
      .select("id, sheet_type, display_name, google_sheet_id, tab_name, row_count, last_refreshed_at")
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
