// Resumable embedding backfill for sheet rows. Each invocation processes up
// to ~2000 missing rows across sheets that have any missing embeddings, then
// returns. Safe to call repeatedly (from admin UI or a pg_cron schedule)
// until `remaining` is 0.

import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";
import { createClient } from "@supabase/supabase-js";
import { ensureSheetEmbeddings } from "@/lib/copilot-agent.functions";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(request: Request) {
  if (!isHookAuthorized(request)) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const perInvocationCap = Math.min(
    Math.max(parseInt(url.searchParams.get("cap") ?? "2000", 10) || 2000, 100),
    5000,
  );

  const admin = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // Pull all sheet registry IDs and their row counts. Small table — one page.
  const { data: sheets, error: regErr } = await admin
    .from("sheet_registry")
    .select("id, display_name")
    .order("updated_at", { ascending: false });
  if (regErr) return json({ error: regErr.message }, 500);

  const results: Array<{
    sheet_id: string;
    display_name: string | null;
    embedded: number;
    total: number;
    remaining: number;
  }> = [];
  let budget = perInvocationCap;

  for (const s of sheets ?? []) {
    if (budget <= 0) break;
    try {
      const r = await ensureSheetEmbeddings(admin, s.id as string, { batchCap: budget });
      if (r.embedded > 0 || r.remaining > 0) {
        results.push({
          sheet_id: s.id as string,
          display_name: (s as any).display_name ?? null,
          ...r,
        });
      }
      budget -= r.embedded;
    } catch (e) {
      results.push({
        sheet_id: s.id as string,
        display_name: (s as any).display_name ?? null,
        embedded: 0,
        total: 0,
        remaining: -1,
      });
      // Continue with next sheet on error.
    }
  }

  const totalRemaining = results.reduce(
    (acc, r) => acc + (r.remaining > 0 ? r.remaining : 0),
    0,
  );
  return json({
    ok: true,
    processed_sheets: results.length,
    embedded_this_run: perInvocationCap - budget,
    total_remaining: totalRemaining,
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
