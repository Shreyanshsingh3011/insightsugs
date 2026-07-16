import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized, unauthorizedResponse } from "@/lib/hook-auth.server";

// Sync ONE sheet per request. The parent coordinator (sheets-refresh) fans
// out one HTTP call per sheet so each sync runs in its own Cloudflare Worker
// isolate with a fresh ~128 MB memory budget. Doing all sheets in a single
// invocation was OOM-killing the Worker (observed 502
// "Worker exceeded memory limit" every 5 minutes).
export const Route = createFileRoute("/api/public/hooks/sheet-refresh-one")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isHookAuthorized(request)) return unauthorizedResponse();

        let body: { id?: string };
        try {
          body = (await request.json()) as { id?: string };
        } catch {
          return Response.json({ ok: false, error: "invalid json body" }, { status: 400 });
        }
        const id = body?.id;
        if (!id || typeof id !== "string") {
          return Response.json({ ok: false, error: "id required" }, { status: 400 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { syncRowsInternal } = await import("@/lib/sheets.functions");

        const { data: reg, error: regErr } = await supabaseAdmin
          .from("sheet_registry")
          .select("id, user_id, display_name, source_url, apps_script_url")
          .eq("id", id)
          .maybeSingle();
        if (regErr) return Response.json({ ok: false, error: regErr.message }, { status: 500 });
        if (!reg) return Response.json({ ok: false, error: "sheet not found" }, { status: 404 });

        const src = String((reg as any).source_url ?? (reg as any).apps_script_url ?? "");
        if (!src || src.startsWith("upload://")) {
          return Response.json({
            ok: true,
            id: reg.id,
            name: reg.display_name,
            skipped: true,
            reason: "static upload — no live source to refresh",
          });
        }

        const t0 = Date.now();
        // Best-effort audit write; never let audit failures fail the sync.
        const writeAudit = async (row: Record<string, any>) => {
          try {
            await (supabaseAdmin.from("sheet_sync_audit") as any).insert(row);
          } catch (e) {
            console.warn("[sheet-refresh-one] audit insert failed", (e as Error).message);
          }
        };


        try {
          const stats = await (syncRowsInternal as any)(supabaseAdmin, reg.user_id, reg.id);
          const totalMs = Date.now() - t0;
          await writeAudit({
            project_id: reg.id,
            project_label: reg.display_name ?? null,
            sheet_url: src.slice(0, 3000),
            fetch_ms: stats?.fetchMs ?? totalMs,
            rows_total: stats?.rowsTotal ?? null,
            rows_added: stats?.rowsAdded ?? 0,
            rows_removed: stats?.rowsRemoved ?? 0,
            rows_changed: stats?.rowsChanged ?? 0,
            trigger_kind: "auto",
            warning: stats?.unchanged ? "unchanged (hash match — no writes)" : null,
          });
          return Response.json({
            ok: true,
            id: reg.id,
            name: reg.display_name,
            ms: totalMs,
            ...stats,
          });
        } catch (e: any) {
          const totalMs = Date.now() - t0;
          await writeAudit({
            project_id: reg.id,
            project_label: reg.display_name ?? null,
            sheet_url: src.slice(0, 3000),
            fetch_ms: totalMs,
            trigger_kind: "auto",
            error: String(e?.message ?? e).slice(0, 2000),
          });
          return Response.json(
            {
              ok: false,
              id: reg.id,
              name: reg.display_name,
              error: String(e?.message ?? e).slice(0, 500),
              ms: totalMs,
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
