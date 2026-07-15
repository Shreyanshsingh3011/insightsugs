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

  // Pull all sheet registry ids.
  const { data: sheets, error: regErr } = await admin
    .from("sheet_registry")
    .select("id, display_name");
  if (regErr) return json({ error: regErr.message }, 500);

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
    try {
      const r = await ensureSheetEmbeddings(admin, s.id, { batchCap: perSheetCap });
      results.push({
        sheet_id: s.id,
        display_name: s.display_name,
        ...r,
      });
    } catch (e: any) {
      results.push({
        sheet_id: s.id,
        display_name: s.display_name,
        embedded: 0,
        total: s.rows,
        remaining: s.missing,
        error: String(e?.message ?? e).slice(0, 300),
      });
    }
  }

  const totalRemaining = ranked.reduce((acc, r) => acc + r.missing, 0);
  return json({
    ok: true,
    processed_sheets: results.length,
    total_remaining_before_run: totalRemaining,
    results,
  });
}

export const Route = createFileRoute("/api/public/hooks/embed-backfill")({
  server: {
    handlers: {
      GET: ({ request }) => run(request),
      POST: ({ request }) => run(request),
    },
  },
});
