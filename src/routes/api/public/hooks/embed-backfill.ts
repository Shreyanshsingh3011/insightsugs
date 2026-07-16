// Resumable embedding backfill for sheet rows. Each invocation targets the
// sheet with the LARGEST embedding gap and processes up to `cap` rows for it,
// then returns. Ordering by biggest-gap-first prevents small already-embedded
// sheets from consuming the Worker's CPU budget before big sheets get a turn
// (the previous updated_at-desc ordering never reached the 50k-row sheets).

import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";
import { createClient } from "@supabase/supabase-js";
import { ensureSheetEmbeddings } from "@/lib/copilot-embeddings.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(request: Request) {
  if (!isHookAuthorized(request)) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const perSheetCap = Math.min(
    Math.max(parseInt(url.searchParams.get("cap") ?? "500", 10) || 500, 50),
    2000,
  );
  // How many sheets to touch per invocation. Keep small so wall-clock stays
  // well under the Worker CPU budget.
  const maxSheetsPerRun = Math.min(
    Math.max(parseInt(url.searchParams.get("sheets") ?? "2", 10) || 2, 1),
    5,
  );

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Global run-lock: skip if a previous invocation is still running. Fixed key
  // shared across all embed-backfill invocations.
  const BACKFILL_LOCK_KEY = "7700000000000042";
  const { data: gotLock } = await (admin as any).rpc("try_run_lock", {
    _key: BACKFILL_LOCK_KEY,
  });
  if (!gotLock) {
    return json({ ok: true, skipped: true, reason: "another backfill already running" });
  }

  try {
  // Pull all sheet registry ids.
  const { data: sheets, error: regErr } = await admin
    .from("sheet_registry")
    .select("id, display_name");
  if (regErr) {
    await (admin as any).rpc("release_run_lock", { _key: BACKFILL_LOCK_KEY });
    return json({ error: regErr.message }, 500);
  }


  // Compute (rows, embedded) for each sheet and rank by missing count desc.
  const ranked: Array<{
    id: string;
    display_name: string | null;
    rows: number;
    embedded: number;
    missing: number;
  }> = [];
  for (const s of sheets ?? []) {
    const [{ count: rowCount }, { count: embCount }] = await Promise.all([
      admin
        .from("sheet_rows")
        .select("row_index", { count: "exact", head: true })
        .eq("sheet_registry_id", s.id as string),
      admin
        .from("sheet_row_embeddings")
        .select("row_index", { count: "exact", head: true })
        .eq("sheet_registry_id", s.id as string),
    ]);
    const rows = rowCount ?? 0;
    const embedded = embCount ?? 0;
    ranked.push({
      id: s.id as string,
      display_name: (s as any).display_name ?? null,
      rows,
      embedded,
      missing: Math.max(rows - embedded, 0),
    });
  }
  ranked.sort((a, b) => b.missing - a.missing);

  const results: Array<{
    sheet_id: string;
    display_name: string | null;
    embedded: number;
    total: number;
    remaining: number;
    error?: string;
  }> = [];

  let touched = 0;
  for (const s of ranked) {
    if (touched >= maxSheetsPerRun) break;
    if (s.missing <= 0) break; // nothing left to embed anywhere
    touched++;
    const t0 = Date.now();
    try {
      const r = await ensureSheetEmbeddings(admin, s.id, { batchCap: perSheetCap });
      const embedMs = Date.now() - t0;
      results.push({
        sheet_id: s.id,
        display_name: s.display_name,
        ...r,
      });
      try {
        await (admin.from("sheet_sync_audit") as any).insert({
          project_id: s.id,
          project_label: s.display_name,
          sheet_url: `embed-backfill://${s.id}`,
          embed_ms: embedMs,
          embed_embedded: r.embedded ?? 0,
          embed_refreshed: (r as any).refreshed ?? 0,
          embed_remaining: r.remaining ?? 0,
          trigger_kind: "auto",
        });
      } catch (e) {
        console.warn("[embed-backfill] audit insert failed", (e as Error).message);
      }
    } catch (e: any) {
      const embedMs = Date.now() - t0;
      results.push({
        sheet_id: s.id,
        display_name: s.display_name,
        embedded: 0,
        total: s.rows,
        remaining: s.missing,
        error: String(e?.message ?? e).slice(0, 300),
      });
      try {
        await (admin.from("sheet_sync_audit") as any).insert({
          project_id: s.id,
          project_label: s.display_name,
          sheet_url: `embed-backfill://${s.id}`,
          embed_ms: embedMs,
          embed_remaining: s.missing,
          trigger_kind: "auto",
          error: String(e?.message ?? e).slice(0, 2000),
        });
      } catch (err) {
        console.warn("[embed-backfill] audit insert failed", (err as Error).message);
      }
    }
  }


  const totalRemaining = ranked.reduce((acc, r) => acc + r.missing, 0);
  return json({
    ok: true,
    processed_sheets: results.length,
    total_remaining_before_run: totalRemaining,
    results,
  });
  } finally {
    try {
      await (admin as any).rpc("release_run_lock", { _key: BACKFILL_LOCK_KEY });
    } catch { /* best-effort */ }
  }
}


export const Route = createFileRoute("/api/public/hooks/embed-backfill")({
  server: {
    handlers: {
      GET: ({ request }) => run(request),
      POST: ({ request }) => run(request),
    },
  },
});
