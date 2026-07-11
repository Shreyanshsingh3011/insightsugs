// Server functions for the sheet-sync audit log. Records:
//  - per-project fetch runs (duration, row diff)
//  - embedding-rebuild runs (duration, embedded/refreshed counts)
// Also exposes a reader for the dashboard's perf-stats panel.

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isAuthTokenError, isRecoverableDataReadError } from "@/lib/transient-errors";
import type { Database } from "@/integrations/supabase/types";

const RecordSchema = z.object({
  project_id: z.string().min(1).max(200),
  project_label: z.string().max(200).optional().nullable(),
  sheet_url: z.string().min(1).max(3000),
  tab_name: z.string().max(200).optional().nullable(),
  fetch_ms: z.number().int().nonnegative().nullable().optional(),
  rows_total: z.number().int().nonnegative().nullable().optional(),
  rows_added: z.number().int().nonnegative().optional(),
  rows_removed: z.number().int().nonnegative().optional(),
  rows_changed: z.number().int().nonnegative().optional(),
  changed_row_indexes: z.array(z.number().int()).max(500).optional(),
  changed_columns: z.array(z.string().max(120)).max(200).optional(),
  embed_ms: z.number().int().nonnegative().nullable().optional(),
  embed_embedded: z.number().int().nonnegative().nullable().optional(),
  embed_refreshed: z.number().int().nonnegative().nullable().optional(),
  embed_remaining: z.number().int().nonnegative().nullable().optional(),
  trigger_kind: z.enum(["auto", "manual", "initial"]).default("auto"),
  warning: z.string().max(2000).nullable().optional(),
  error: z.string().max(2000).nullable().optional(),
});

export const recordSyncAudit = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => RecordSchema.parse(input))
  .handler(async ({ data }) => {
    try {
      const authHeader = getRequestHeader("authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
      if (!token) return { ok: false, skipped: true, reason: "missing_auth" };

      const supabaseUrl = process.env.SUPABASE_URL;
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !publishableKey) {
        return { ok: false, skipped: true, reason: "backend_not_configured" };
      }

      const supabase = createClient<Database>(supabaseUrl, publishableKey, {
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });

      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user?.id) {
        console.warn(`[sync-audit] skipped audit write: ${userError?.message ?? "missing user"}`);
        return { ok: false, skipped: true, reason: "invalid_auth" };
      }

      const { error } = await supabase.from("sheet_sync_audit").insert({
        ...data,
        actor_id: userData.user.id,
      });
      if (error) {
        console.warn(`[sync-audit] skipped audit write: ${error.message}`);
        return { ok: false, skipped: true, reason: "write_unavailable" };
      }
      return { ok: true, skipped: false };
    } catch (error) {
      console.warn("[sync-audit] skipped audit write after backend/auth failure.", error);
      return {
        ok: false,
        skipped: true,
        reason: isAuthTokenError(error) ? "invalid_auth" : isRecoverableDataReadError(error) ? "backend_unavailable" : "write_unavailable",
      };
    }
  });

export type SyncAuditRow = {
  id: string;
  project_id: string;
  project_label: string | null;
  sheet_url: string;
  tab_name: string | null;
  fetched_at: string;
  fetch_ms: number | null;
  rows_total: number | null;
  rows_added: number | null;
  rows_removed: number | null;
  rows_changed: number | null;
  changed_row_indexes: number[] | null;
  changed_columns: string[] | null;
  embed_ms: number | null;
  embed_embedded: number | null;
  embed_refreshed: number | null;
  embed_remaining: number | null;
  trigger_kind: string;
  warning: string | null;
  error: string | null;
};

export const readRecentSyncAudit = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ limit: z.number().int().positive().max(200).default(40) }).parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<{ rows: SyncAuditRow[]; unavailable?: boolean }> => {
    try {
      const authHeader = getRequestHeader("authorization");
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
      if (!token) return { rows: [], unavailable: true };

      const supabaseUrl = process.env.SUPABASE_URL;
      const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
      if (!supabaseUrl || !publishableKey) return { rows: [], unavailable: true };

      const supabase = createClient<Database>(supabaseUrl, publishableKey, {
        auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
      });

      const { data: rows, error } = await supabase
        .from("sheet_sync_audit")
        .select(
          "id, project_id, project_label, sheet_url, tab_name, fetched_at, fetch_ms, rows_total, rows_added, rows_removed, rows_changed, changed_row_indexes, changed_columns, embed_ms, embed_embedded, embed_refreshed, embed_remaining, trigger_kind, warning, error",
        )
        .order("fetched_at", { ascending: false })
        .limit(data.limit);
      if (error) {
        console.warn(`[sync-audit] skipped audit read: ${error.message}`);
        return { rows: [], unavailable: true };
      }
      return { rows: (rows ?? []) as SyncAuditRow[] };
    } catch (error) {
      console.warn("[sync-audit] skipped audit read after backend/auth failure.", error);
      return { rows: [], unavailable: true };
    }
  });
