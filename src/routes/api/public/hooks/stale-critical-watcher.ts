// Public cron-callable watcher. Scans recent high-severity alerts and queues
// a "nudge" pending_action for anything critical + open longer than 48h with
// no owner action. Idempotent: skips activities already queued in last 24h.
//
// Wire with pg_cron:
//   SELECT cron.schedule('stale-critical-watcher', '0 */4 * * *', $$
//     SELECT net.http_post(
//       url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/stale-critical-watcher',
//       headers := jsonb_build_object('Content-Type','application/json','apikey','YOUR_ANON_KEY'),
//       body := '{}'::jsonb) $$);
import { createFileRoute } from "@tanstack/react-router";

async function runWatcher() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { startAgentRun, finishAgentRun } = await import("@/lib/agent-runs.server");

  const run = await startAgentRun({
    agent: "watcher",
    trigger: "cron",
    actorId: null,
    input: { kind: "stale_critical_alerts" },
  });

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const dedupCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Find critical, open, aged alerts. Uses agent_drafts as a proxy source.
  // Adjust to your alerts table shape as needed.
  const { data: alerts, error } = await supabaseAdmin
    .from("alerts")
    .select("id, title, severity, status, created_at")
    .eq("severity", "critical")
    .neq("status", "resolved")
    .lt("created_at", cutoff)
    .limit(50);

  if (error) {
    await finishAgentRun(run, { status: "failed", error: error.message });
    return { ok: false, error: error.message };
  }

  const items = alerts ?? [];
  let queued = 0;
  let skipped = 0;

  for (const a of items) {
    // Dedup: skip if we queued a nudge for this alert in the last 24h.
    const { data: existing } = await supabaseAdmin
      .from("pending_actions")
      .select("id")
      .eq("kind", "watcher_nudge")
      .gte("created_at", dedupCutoff)
      .contains("payload", { alert_id: a.id })
      .limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    await supabaseAdmin.from("pending_actions").insert({
      kind: "watcher_nudge",
      title: `Stale critical: ${a.title}`,
      summary: `Critical alert has been open >48h with no resolution.`,
      rationale: `Automatic watcher flagged this because severity=critical and status=${a.status} since ${a.created_at}. Consider escalating or reassigning.`,
      payload: { alert_id: a.id, severity: a.severity, opened_at: a.created_at } as never,
      proposed_by: null,
      run_id: run?.id ?? null,
      status: "pending",
    });
    queued++;
  }

  await finishAgentRun(run, {
    status: "succeeded",
    output: { scanned: items.length, queued, skipped },
  });

  return { ok: true, scanned: items.length, queued, skipped };
}

export const Route = createFileRoute("/api/public/hooks/stale-critical-watcher")({
  server: {
    handlers: {
      GET: async () => Response.json(await runWatcher()),
      POST: async () => Response.json(await runWatcher()),
    },
  },
});
