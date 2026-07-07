// Cron/external hook: runs the autonomous agent tick that scans overdue
// activities and queues alert proposals for approval at /agent/approvals.

import { createFileRoute } from "@tanstack/react-router";

function isAuthorized(request: Request): boolean {
  const url = new URL(request.url);
  const provided =
    request.headers.get("apikey") ??
    request.headers.get("x-api-key") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("apikey") ??
    "";
  if (!provided) return false;
  const allowed = [
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ].filter(Boolean) as string[];
  return allowed.includes(provided);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const { runAgentTick } = await import("@/lib/agent-tick.server");
    const result = await runAgentTick();
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export const Route = createFileRoute("/api/public/agent-tick")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
