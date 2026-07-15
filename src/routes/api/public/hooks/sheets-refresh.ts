import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized, unauthorizedResponse } from "@/lib/hook-auth.server";

// Coordinator: pg_cron hits this every ~5 minutes. Instead of syncing every
// sheet inline (which OOMed the Worker at ~128 MB per invocation), we fan
// out one HTTP call per sheet to /api/public/hooks/sheet-refresh-one.
// Each per-sheet call runs in its own Worker isolate with a fresh memory
// budget, and this coordinator stays tiny.
export const Route = createFileRoute("/api/public/hooks/sheets-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isHookAuthorized(request)) return unauthorizedResponse();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: regs, error } = await supabaseAdmin
          .from("sheet_registry")
          .select("id, display_name");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        // Reuse the caller's secret to authorize the fan-out; falls back to
        // CRON_HOOK_SECRET (which is what pg_cron sends anyway).
        const authHeader =
          request.headers.get("authorization") ||
          (process.env.CRON_HOOK_SECRET ? `Bearer ${process.env.CRON_HOOK_SECRET}` : "");

        const origin = new URL(request.url).origin;
        const target = `${origin}/api/public/hooks/sheet-refresh-one`;

        // Fire-and-forget. We deliberately do NOT await the responses — the
        // whole point is to release this Worker before any per-sheet sync
        // starts allocating. Each sub-request gets its own isolate.
        // waitUntil isn't reachable from this handler shape, so we detach
        // the promises and swallow rejections so they don't crash the isolate.
        const dispatched: string[] = [];
        for (const r of regs ?? []) {
          try {
            const p = fetch(target, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(authHeader ? { authorization: authHeader } : {}),
              },
              body: JSON.stringify({ id: r.id }),
              // keepalive lets the request survive the parent Worker returning.
              keepalive: true,
            });
            p.catch(() => {
              /* individual sheet errors are logged in the sub-route */
            });
            dispatched.push(r.id);
          } catch {
            // network setup errors shouldn't sink the coordinator
          }
        }

        return Response.json({
          ok: true,
          strategy: "fanout",
          dispatched: dispatched.length,
          total: regs?.length ?? 0,
        });
      },
    },
  },
});
