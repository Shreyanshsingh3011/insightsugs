import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";
import { runWeeklyBriefing } from "@/lib/weekly-briefing-run.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/hooks/weekly-briefing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isHookAuthorized(request)) return json({ error: "Unauthorized" }, 401);
        const origin = new URL(request.url).origin;
        const result = await runWeeklyBriefing({ origin, sendEmail: true });
        return json(result);
      },
    },
  },
});
