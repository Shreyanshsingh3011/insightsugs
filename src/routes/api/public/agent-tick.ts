// Cron/external hook: runs the autonomous agent tick that scans overdue
// activities and queues alert proposals for approval at /agent/approvals.

import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(request: Request): Promise<Response> {
  if (!isHookAuthorized(request)) return json({ error: "Unauthorized" }, 401);
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
