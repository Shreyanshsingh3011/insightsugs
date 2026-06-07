import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// SLA hours before re-notifying open concerns by severity.
const SLA_HOURS: Record<string, number> = {
  Critical: 4,
  High: 12,
  Medium: 24,
  Low: 72,
};

export const Route = createFileRoute("/api/public/hooks/concern-nudges")({
  server: {
    handlers: {
      POST: async () => {
        const url = process.env.SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const admin = createClient(url, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data: open, error } = await admin
          .from("concerns")
          .select("id, target_dept, activity, title, severity, created_at, last_nudged_at")
          .neq("status", "resolved");
        if (error) return json({ ok: false, error: error.message }, 500);

        const now = Date.now();
        let nudged = 0;
        for (const c of open ?? []) {
          const sevHours = SLA_HOURS[(c as any).severity] ?? 24;
          const last = (c as any).last_nudged_at ? new Date((c as any).last_nudged_at).getTime() : new Date((c as any).created_at).getTime();
          if (now - last < sevHours * 3600 * 1000) continue;

          const { data: members } = await admin
            .from("profiles")
            .select("id")
            .eq("department", (c as any).target_dept);
          const rows = (members ?? []).map((m: any) => ({
            user_id: m.id,
            kind: "concern_nudge",
            title: `Reminder: ${(c as any).title}`.slice(0, 200),
            body: `Concern still open (${(c as any).severity}). Please review and respond.`.slice(0, 500),
          }));
          if (rows.length) {
            await admin.from("notifications").insert(rows);
          }
          await admin.from("concerns").update({ last_nudged_at: new Date().toISOString() }).eq("id", (c as any).id);
          nudged += 1;
        }

        await admin.from("escalation_runs").insert({
          overdue_count: open?.length ?? 0,
          notifications_created: nudged,
          details: { kind: "concern_nudges" },
        });

        return json({ ok: true, nudged, open: open?.length ?? 0 });
      },
    },
  },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
