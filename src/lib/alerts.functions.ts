import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const FlagSnapshot = z.object({
  id: z.string().min(1).max(100),
  activity: z.string().min(1).max(500),
  stage: z.string().max(200).optional().nullable(),
  severity: z.string().max(50).optional().nullable(),
  source: z.string().max(200).optional().nullable(),
  root_cause: z.string().max(2000).optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
  responsible_email: z.string().email().max(255).optional().nullable(),
  responsible_name: z.string().max(255).optional().nullable(),
});

async function assertAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r: any) => r.role);
  if (!roles.includes("admin") && !roles.includes("super_admin")) {
    throw new Error("Only admins can perform this action.");
  }
}

export const sendAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { flag: unknown }) => ({ flag: FlagSnapshot.parse(d.flag) }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const flag = data.flag;

    // Use admin client for recipient resolution + cross-user notifications
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Build recipient set
    const recipients = new Map<string, { user_id: string | null; email: string; name: string | null }>();
    const addRecip = (email?: string | null, user_id?: string | null, name?: string | null) => {
      const e = (email ?? "").trim().toLowerCase();
      if (!e) return;
      if (!recipients.has(e)) recipients.set(e, { user_id: user_id ?? null, email: e, name: name ?? null });
    };

    // Responsible person
    if (flag.responsible_email) {
      const { data: prof } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, email")
        .ilike("email", flag.responsible_email)
        .maybeSingle();
      addRecip(flag.responsible_email, prof?.id ?? null, prof?.full_name ?? flag.responsible_name ?? null);
    }

    // Match activity by title -> project_id
    const { data: actMatches } = await supabaseAdmin
      .from("activities")
      .select("id, project_id, assignee_id, depends_on")
      .ilike("title", flag.activity)
      .limit(5);

    const projectIds = new Set<string>();
    const matchedActivityIds = new Set<string>();
    (actMatches ?? []).forEach((a: any) => {
      if (a.project_id) projectIds.add(a.project_id);
      matchedActivityIds.add(a.id);
    });

    // Project members
    if (projectIds.size > 0) {
      const { data: members } = await supabaseAdmin
        .from("project_members")
        .select("user_id, profiles!inner(id, full_name, email)")
        .in("project_id", Array.from(projectIds));
      (members ?? []).forEach((m: any) => addRecip(m.profiles?.email, m.user_id, m.profiles?.full_name));
    }

    // Dependent activity assignees (activities that depend on or are depended-on by the flagged one)
    if (matchedActivityIds.size > 0) {
      const ids = Array.from(matchedActivityIds);
      const { data: depActs } = await supabaseAdmin
        .from("activities")
        .select("assignee_id, depends_on, id, profiles:assignee_id(id, full_name, email)")
        .or(`depends_on.in.(${ids.join(",")}),id.in.(${(actMatches ?? []).map((a: any) => a.depends_on).filter(Boolean).join(",") || "00000000-0000-0000-0000-000000000000"})`);
      (depActs ?? []).forEach((a: any) => addRecip(a.profiles?.email, a.assignee_id, a.profiles?.full_name));
    }

    // 2. Upsert alert row
    const { data: existing } = await supabaseAdmin
      .from("alerts")
      .select("id")
      .eq("flag_id", flag.id)
      .maybeSingle();

    if (existing) {
      throw new Error("This alert has already been dispatched.");
    }

    const { data: alertRow, error: insErr } = await supabaseAdmin
      .from("alerts")
      .insert({
        flag_id: flag.id,
        activity: flag.activity,
        stage: flag.stage ?? null,
        severity: flag.severity ?? null,
        source: flag.source ?? flag.stage ?? null,
        root_cause: flag.root_cause ?? null,
        reason: flag.reason ?? null,
        sent_by: userId,
      })
      .select("id")
      .single();
    if (insErr || !alertRow) throw new Error(insErr?.message ?? "Failed to create alert");

    // 3. Insert recipient rows (one inapp + one email per recipient)
    const recList = Array.from(recipients.values());
    const rows: any[] = [];
    const now = new Date().toISOString();
    for (const r of recList) {
      if (r.user_id) {
        rows.push({ alert_id: alertRow.id, user_id: r.user_id, email: r.email, name: r.name, channel: "inapp", delivered_at: now });
      }
      rows.push({ alert_id: alertRow.id, user_id: r.user_id, email: r.email, name: r.name, channel: "email", error: "email_pending_setup" });
    }
    if (rows.length) {
      await supabaseAdmin.from("alert_recipients").insert(rows);
    }

    // 4. In-app notifications
    const notifRows = recList
      .filter((r) => r.user_id)
      .map((r) => ({
        user_id: r.user_id,
        kind: "alert",
        title: `Alert: ${flag.activity}`.slice(0, 200),
        body: (flag.root_cause ?? flag.reason ?? `Severity ${flag.severity ?? "—"} · Stage ${flag.stage ?? "—"}`).slice(0, 500),
      }));
    if (notifRows.length) {
      await supabaseAdmin.from("notifications").insert(notifRows);
    }

    return {
      alertId: alertRow.id,
      recipientCount: recList.length,
      inappCount: notifRows.length,
      emailPending: rows.filter((r) => r.channel === "email").length,
    };
  });

export const getAlertByFlag = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { flagId: string }) => ({ flagId: z.string().min(1).max(100).parse(d.flagId) }))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: alert } = await supabase
      .from("alerts")
      .select("*")
      .eq("flag_id", data.flagId)
      .maybeSingle();
    if (!alert) return { alert: null, recipients: [], messages: [] };

    const [{ data: recipients }, { data: messages }] = await Promise.all([
      supabase.from("alert_recipients").select("*").eq("alert_id", alert.id).order("created_at"),
      supabase.from("alert_messages").select("id, body, author_id, created_at").eq("alert_id", alert.id).order("created_at"),
    ]);

    // Resolve author names
    const authorIds = Array.from(new Set((messages ?? []).map((m: any) => m.author_id)));
    let authorMap: Record<string, { full_name: string | null; email: string | null }> = {};
    if (authorIds.length) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: profs } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, email")
        .in("id", authorIds);
      (profs ?? []).forEach((p: any) => { authorMap[p.id] = { full_name: p.full_name, email: p.email }; });
    }

    return {
      alert,
      recipients: recipients ?? [],
      messages: (messages ?? []).map((m: any) => ({ ...m, author: authorMap[m.author_id] ?? null })),
    };
  });

export const replyToAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { alertId: string; body: string }) => ({
    alertId: z.string().uuid().parse(d.alertId),
    body: z.string().trim().min(1).max(4000).parse(d.body),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("alert_messages")
      .insert({ alert_id: data.alertId, author_id: userId, body: data.body });
    if (error) throw new Error(error.message);

    // Notify other recipients in-app
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: alert } = await supabaseAdmin
      .from("alerts")
      .select("activity, flag_id, sent_by")
      .eq("id", data.alertId)
      .maybeSingle();
    const { data: recips } = await supabaseAdmin
      .from("alert_recipients")
      .select("user_id")
      .eq("alert_id", data.alertId)
      .eq("channel", "inapp");
    const toNotify = Array.from(new Set([
      ...(recips ?? []).map((r: any) => r.user_id).filter(Boolean),
      alert?.sent_by,
    ])).filter((u): u is string => !!u && u !== userId);
    if (toNotify.length && alert) {
      await supabaseAdmin.from("notifications").insert(
        toNotify.map((uid) => ({
          user_id: uid,
          kind: "alert_reply",
          title: `New reply on ${alert.activity}`.slice(0, 200),
          body: data.body.slice(0, 500),
        })),
      );
    }
    return { ok: true };
  });

export const resolveAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { alertId: string }) => ({ alertId: z.string().uuid().parse(d.alertId) }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await assertAdmin(supabase, userId);
    const { error } = await supabase
      .from("alerts")
      .update({ status: "resolved", resolved_by: userId, resolved_at: new Date().toISOString() })
      .eq("id", data.alertId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
