// Cron/external hook for the Agent Watchers rule engine.
// Auth: caller must present a matching Supabase publishable key OR anon key
// (Cloudflare's /api/public/* bypass is edge-only; we still verify here).

import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";

export const Route = createFileRoute("/api/public/hooks/agent-watchers")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});

async function handle(request: Request): Promise<Response> {
  if (!isHookAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  try {
    const { runAgentWatchersFromHook } = await import("@/lib/agent-watchers.functions");
    const result = await runAgentWatchersFromHook();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
