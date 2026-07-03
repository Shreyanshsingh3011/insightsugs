import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type TimelineEvent = {
  id: string;
  at: string;
  kind: "alert_sent" | "alert_reply" | "alert_status" | "notification";
  title: string;
  body: string | null;
  actor: { id: string | null; name: string | null; email: string | null };
  severity?: string | null;
  status?: string | null;
  alert_id?: string;
  flag_id?: string;
};

/**
 * Timeline of every mail/message dispatch, reply, and status change that is
 * tied to a source record (identified loosely by the activity title). All
 * reads go through the authenticated Supabase client so RLS applies.
 */
export const getSourceTimeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { activity: string; stage?: string | null }) => d)
  .handler(async ({ data, context }): Promise<TimelineEvent[]> => {
    const { supabase } = context;
    const title = (data.activity ?? "").trim();
    if (!title) return [];

    // 1. Alerts whose activity resembles this source record.
    const like = `%${title.slice(0, 120).replace(/[%_]/g, " ")}%`;
    const { data: alerts } = await supabase
      .from("alerts")
      .select("id, flag_id, activity, stage, severity, status, sent_by, resolved_by, resolved_at, created_at, updated_at, root_cause")
      .ilike("activity", like)
      .order("created_at", { ascending: true })
      .limit(50);
    const alertsArr = (alerts ?? []).filter(a =>
      !data.stage || !a.stage || a.stage.toLowerCase() === (data.stage ?? "").toLowerCase(),
    );

    if (!alertsArr.length) return [];

    const alertIds = alertsArr.map(a => a.id);
    const { data: messages } = await supabase
      .from("alert_messages")
      .select("id, alert_id, author_id, body, created_at")
      .in("alert_id", alertIds)
      .order("created_at", { ascending: true });

    // Resolve actor profiles in one shot.
    const actorIds = Array.from(new Set([
      ...alertsArr.map(a => a.sent_by),
      ...alertsArr.map(a => a.resolved_by).filter(Boolean) as string[],
      ...((messages ?? []).map(m => m.author_id)),
    ].filter(Boolean) as string[]));
    let actorMap: Record<string, { name: string | null; email: string | null }> = {};
    if (actorIds.length) {
      const { data: profs } = await supabase
        .from("profiles").select("id, full_name, email").in("id", actorIds);
      actorMap = Object.fromEntries((profs ?? []).map(p => [p.id, { name: p.full_name, email: p.email }]));
    }

    const events: TimelineEvent[] = [];
    for (const a of alertsArr) {
      const actor = a.sent_by ? actorMap[a.sent_by] : null;
      events.push({
        id: `alert-${a.id}`,
        at: a.created_at,
        kind: "alert_sent",
        title: `Alert dispatched · ${a.severity ?? "med"} severity`,
        body: a.root_cause ?? null,
        actor: { id: a.sent_by, name: actor?.name ?? null, email: actor?.email ?? null },
        severity: a.severity,
        status: a.status,
        alert_id: a.id,
        flag_id: a.flag_id,
      });
      if (a.resolved_at) {
        const r = a.resolved_by ? actorMap[a.resolved_by] : null;
        events.push({
          id: `resolved-${a.id}`,
          at: a.resolved_at,
          kind: "alert_status",
          title: `Alert resolved`,
          body: null,
          actor: { id: a.resolved_by, name: r?.name ?? null, email: r?.email ?? null },
          alert_id: a.id,
        });
      }
    }
    for (const m of messages ?? []) {
      const actor = actorMap[m.author_id];
      events.push({
        id: `msg-${m.id}`,
        at: m.created_at,
        kind: "alert_reply",
        title: "Reply / message",
        body: m.body,
        actor: { id: m.author_id, name: actor?.name ?? null, email: actor?.email ?? null },
        alert_id: m.alert_id,
      });
    }
    events.sort((x, y) => x.at.localeCompare(y.at));
    return events;
  });
