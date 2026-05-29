import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// Weekly report: aggregates last 7 days of activity stats and stores in weekly_reports.
export const Route = createFileRoute("/api/public/hooks/weekly-report")({
  server: {
    handlers: {
      POST: async () => {
        const url = process.env.SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

        const now = new Date();
        const end = new Date(now);
        const start = new Date(now);
        start.setDate(start.getDate() - 7);
        const startISO = start.toISOString().slice(0, 10);
        const endISO = end.toISOString().slice(0, 10);

        const { data: activities } = await admin
          .from("activities").select("id, status, completed_at, due_date, assignee_id");

        const todayISO = endISO;
        let completedThisWeek = 0;
        let overdue = 0;
        const perAssignee = new Map<string, { completed: number; overdue: number }>();

        for (const a of activities ?? []) {
          if (a.completed_at && a.completed_at >= startISO && a.completed_at <= `${endISO}T23:59:59`) {
            completedThisWeek++;
            if (a.assignee_id) {
              const cur = perAssignee.get(a.assignee_id) ?? { completed: 0, overdue: 0 };
              cur.completed++;
              perAssignee.set(a.assignee_id, cur);
            }
          }
          if (a.due_date && a.due_date < todayISO && a.status !== "completed") {
            overdue++;
            if (a.assignee_id) {
              const cur = perAssignee.get(a.assignee_id) ?? { completed: 0, overdue: 0 };
              cur.overdue++;
              perAssignee.set(a.assignee_id, cur);
            }
          }
        }

        const summary = {
          completed_this_week: completedThisWeek,
          overdue,
          per_assignee: Object.fromEntries(perAssignee),
        };

        const { data: report, error } = await admin
          .from("weekly_reports")
          .insert({ week_start: startISO, week_end: endISO, summary })
          .select().single();
        if (error) return json({ ok: false, error: error.message }, 500);

        // Notify admins in-app
        const { data: admins } = await admin
          .from("user_roles").select("user_id, role").in("role", ["admin", "super_admin"]);
        const adminIds = Array.from(new Set((admins ?? []).map((a) => a.user_id)));
        if (adminIds.length > 0) {
          await admin.from("notifications").insert(
            adminIds.map((uid) => ({
              user_id: uid,
              kind: "weekly_report",
              title: `Weekly report ${startISO} → ${endISO}`,
              body: `${completedThisWeek} completed, ${overdue} overdue.`,
            })),
          );
        }

        return json({ ok: true, report });
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
