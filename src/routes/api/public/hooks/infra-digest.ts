// Weekly infra digest: aggregates the last 7 days of integration_health
// probes and emails super admins a short summary so nothing lands on the
// team cold on Monday morning.

import { createFileRoute } from "@tanstack/react-router";
import { isHookAuthorized } from "@/lib/hook-auth.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type HealthRow = { name: string; status: string; latency_ms: number | null; error: string | null; checked_at: string };

function summarize(rows: HealthRow[]) {
  const byName = new Map<string, { total: number; down: number; degraded: number; avgMs: number; lastError?: string | null }>();
  for (const r of rows) {
    const prev = byName.get(r.name) ?? { total: 0, down: 0, degraded: 0, avgMs: 0, lastError: null };
    prev.total += 1;
    if (r.status === "down") prev.down += 1;
    else if (r.status === "degraded") prev.degraded += 1;
    prev.avgMs = (prev.avgMs * (prev.total - 1) + (r.latency_ms ?? 0)) / prev.total;
    if (r.error) prev.lastError = r.error;
    byName.set(r.name, prev);
  }
  return Array.from(byName.entries())
    .map(([name, s]) => ({
      name,
      total: s.total,
      down_pct: Math.round((s.down / s.total) * 100),
      degraded_pct: Math.round((s.degraded / s.total) * 100),
      avg_ms: Math.round(s.avgMs),
      last_error: s.lastError,
    }))
    .sort((a, b) => b.down_pct - a.down_pct);
}

function renderHtml(summary: ReturnType<typeof summarize>): string {
  const rows = summary
    .map(
      (s) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${s.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${s.total}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${s.down_pct > 5 ? "#c00" : "#333"}">${s.down_pct}%</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${s.degraded_pct}%</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${s.avg_ms}ms</td>
    </tr>`,
    )
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto">
    <h2 style="margin-bottom:4px">Weekly infra digest</h2>
    <p style="color:#666;margin-top:0">Last 7 days of integration health probes.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f7f7f7;text-align:left">
        <th style="padding:8px 10px">Integration</th>
        <th style="padding:8px 10px;text-align:right">Probes</th>
        <th style="padding:8px 10px;text-align:right">Down</th>
        <th style="padding:8px 10px;text-align:right">Degraded</th>
        <th style="padding:8px 10px;text-align:right">Avg latency</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px"><a href="https://insightsugs.lovable.app/admin/health">Open health dashboard →</a></p>
  </div>`;
}

async function handle(request: Request): Promise<Response> {
  if (!isHookAuthorized(request)) return json({ error: "unauthorized" }, 401);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabaseAdmin
    .from("integration_health")
    .select("name,status,latency_ms,error,checked_at")
    .gte("checked_at", since)
    .order("checked_at", { ascending: false })
    .limit(5000);
  if (error) return json({ error: error.message }, 500);

  const summary = summarize((rows ?? []) as unknown as HealthRow[]);
  const html = renderHtml(summary);

  const { data: recipients } = await supabaseAdmin.rpc("list_super_admin_emails");
  const list = (recipients ?? []) as { user_id: string; email: string; full_name: string | null }[];

  const resendKey = process.env.RESEND_API_KEY;
  let sent = 0;
  if (resendKey && list.length > 0) {
    for (const admin of list) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${resendKey}`,
          },
          body: JSON.stringify({
            from: "insightsugs <notify@notify.sugslloyds.com>",
            to: admin.email,
            subject: "Weekly infra digest",
            html,
          }),
        });
        if (res.ok) sent += 1;
      } catch { /* keep going */ }
    }
  }

  return json({
    ok: true,
    probes: rows?.length ?? 0,
    integrations: summary.length,
    emailed: sent,
    recipients: list.length,
    checked_at: new Date().toISOString(),
  });
}

export const Route = createFileRoute("/api/public/hooks/infra-digest")({
  server: {
    handlers: {
      GET: async ({ request }) => handle(request),
      POST: async ({ request }) => handle(request),
    },
  },
});
