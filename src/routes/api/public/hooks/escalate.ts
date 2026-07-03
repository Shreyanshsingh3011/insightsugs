import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

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

// Daily escalation job: find overdue activities, drop in-app notifications for assignees and admins.
export const Route = createFileRoute("/api/public/hooks/escalate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorized(request)) return json({ error: "Unauthorized" }, 401);
        const url = process.env.SUPABASE_URL!;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
        const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

        const today = new Date().toISOString().slice(0, 10);
        const { data: overdue, error } = await admin
          .from("activities")
          .select("id, project_id, title, assignee_id, due_date, status")
          .lt("due_date", today)
          .neq("status", "completed");
        if (error) return json({ ok: false, error: error.message }, 500);

        const { data: admins } = await admin
          .from("user_roles").select("user_id, role").in("role", ["admin", "super_admin"]);
        const adminIds = Array.from(new Set((admins ?? []).map((a) => a.user_id)));

        const notifications: Array<Record<string, unknown>> = [];
        for (const a of overdue ?? []) {
          if (a.assignee_id) {
            notifications.push({
              user_id: a.assignee_id,
              kind: "overdue",
              title: `Overdue: ${a.title}`,
              body: `Due ${a.due_date}. Please update status or add a delay reason.`,
              activity_id: a.id,
              project_id: a.project_id,
            });
          }
          for (const adminId of adminIds) {
            notifications.push({
              user_id: adminId,
              kind: "escalation",
              title: `Escalation: ${a.title}`,
              body: `Activity overdue since ${a.due_date}.`,
              activity_id: a.id,
              project_id: a.project_id,
            });
          }
        }

        let inserted = 0;
        if (notifications.length > 0) {
          const { error: insErr, count } = await admin
            .from("notifications").insert(notifications, { count: "exact" });
          if (insErr) return json({ ok: false, error: insErr.message }, 500);
          inserted = count ?? notifications.length;
        }

        await admin.from("escalation_runs").insert({
          overdue_count: overdue?.length ?? 0,
          notifications_created: inserted,
          details: { date: today },
        });

        return json({ ok: true, overdue: overdue?.length ?? 0, notifications: inserted });
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
