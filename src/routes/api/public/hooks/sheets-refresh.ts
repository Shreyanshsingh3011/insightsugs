import { createFileRoute } from "@tanstack/react-router";

// Server-side scheduled sheet refresh. pg_cron hits this every 5 minutes;
// iterates every registered sheet and re-pulls rows from the source so the
// agent dashboard reflects changes without needing anyone to have the sheet
// detail page open.
export const Route = createFileRoute("/api/public/hooks/sheets-refresh")({
  server: {
    handlers: {
      POST: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { syncRowsInternal } = await import("@/lib/sheets.functions");

        const { data: regs, error } = await supabaseAdmin
          .from("sheet_registry")
          .select("id, user_id, display_name");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: {
          id: string;
          name: string;
          ok: boolean;
          error?: string;
          ms: number;
        }[] = [];

        for (const r of regs ?? []) {
          const t0 = Date.now();
          try {
            await (syncRowsInternal as any)(supabaseAdmin, r.user_id, r.id);
            results.push({ id: r.id, name: r.display_name, ok: true, ms: Date.now() - t0 });
          } catch (e: any) {
            results.push({
              id: r.id,
              name: r.display_name,
              ok: false,
              error: String(e?.message ?? e).slice(0, 300),
              ms: Date.now() - t0,
            });
          }
        }

        return Response.json({
          ok: true,
          synced: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          total: results.length,
          results,
        });
      },
    },
  },
});
