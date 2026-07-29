// Route: "/api/public/hooks/delay-root-cause" (public API hook).
// Auth: shared cron/webhook secret via isHookAuthorized() (@/lib/hook-auth.server) — requires header Authorization: Bearer <CRON_HOOK_SECRET> (or x-cron-secret/apikey/x-api-key), or the Supabase service-role key. Intended callers: pg_cron / external schedulers, not browsers.
import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";

/** Cron/webhook handler for "/api/public/hooks/delay-root-cause". Verifies the caller via isHookAuthorized() before doing any work; returns JSON { ok, ... }. */
async function handle(request: Request): Promise<Response> {
  if (!isHookAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  try {
    const { runDelayRootCauseFromHook } = await import("@/lib/delay-root-cause.functions");
    const result = await runDelayRootCauseFromHook();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}

export const Route = createFileRoute("/api/public/hooks/delay-root-cause")({
  server: { handlers: { GET: async ({ request }) => handle(request), POST: async ({ request }) => handle(request) } },
});
