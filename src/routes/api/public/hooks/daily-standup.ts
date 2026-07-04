import { createFileRoute } from "@tanstack/react-router";

async function isAuthorized(request: Request): Promise<boolean> {
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

async function handle(request: Request): Promise<Response> {
  if (!(await isAuthorized(request))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }
  try {
    const { runStandupAgentFromHook } = await import("@/lib/standup-agent.functions");
    const result = await runStandupAgentFromHook();
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { "content-type": "application/json" },
    });
  }
}

export const Route = createFileRoute("/api/public/hooks/daily-standup")({
  server: { handlers: { GET: async ({ request }) => handle(request), POST: async ({ request }) => handle(request) } },
});
