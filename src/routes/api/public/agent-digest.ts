// Cron/external hook: sends the morning digest of agent-queued proposals to
// super admins via email (and Slack when a Slack connector is linked).

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
    const { runAgentDigest } = await import("@/lib/agent-digest.server");
    const result = await runAgentDigest();
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export const Route = createFileRoute("/api/public/agent-digest")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
