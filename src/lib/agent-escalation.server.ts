// Auto-escalation ladder for pending_actions (agent proposals).
//
// When a proposal sits unapproved beyond a per-tier SLA, we:
//   1. Recompute freshness (re-runs the lightweight "investigateDelay" step
//      by re-reading the underlying activity's days_over and status).
//   2. Upgrade severity in the payload (info → warning → critical).
//   3. Ping the next tier via notifications:
//        tier 0 → assignee (owner of the activity)
//        tier 1 → project admins (project owner + members with admin role)
//        tier 2 → super_admins (org-wide)
//   4. Stamp escalation_tier / escalation_count / last_escalated_at.
//
// Idempotent: a proposal only advances one tier per invocation, and only if
// `last_escalated_at` (or created_at if null) is older than the tier's SLA.

const TIER_HOURS: Record<number, number> = {
  0: 6, // assignee gets 6h to react before we bump to admins
  1: 12, // admins get 12h before we bump to super_admins
  2: 24, // super_admins get 24h; after that we stop bumping (already at top)
};

const NEXT_SEVERITY: Record<string, "info" | "warning" | "critical"> = {
  info: "warning",
  warning: "critical",
  critical: "critical",
};

type ActionRow = {
  id: string;
  kind: string;
  title: string | null;
  summary: string;
  status: string;
  payload: Record<string, unknown> | null;
  proposed_by: string | null;
  assigned_to: string | null;
  created_at: string;
  escalation_tier: number;
  escalation_count: number;
  last_escalated_at: string | null;
};

function hoursSince(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

export async function runEscalationLadder(): Promise<{
  scanned: number;
  escalated: number;
  notifications: number;
  errors: string[];
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const errors: string[] = [];

  const { data: actions, error } = await supabaseAdmin
    .from("pending_actions")
    .select(
      "id, kind, title, summary, status, payload, proposed_by, assigned_to, created_at, escalation_tier, escalation_count, last_escalated_at",
    )
    .eq("status", "pending")
    .lt("escalation_tier", 3)
    .limit(200);

  if (error) {
    return { scanned: 0, escalated: 0, notifications: 0, errors: [error.message] };
  }

  const rows = (actions ?? []) as ActionRow[];
  let escalatedCount = 0;
  let notifCount = 0;

  // Preload super_admin ids once.
  const { data: superRoles } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "super_admin");
  const superAdminIds = Array.from(
    new Set((superRoles ?? []).map((r) => r.user_id).filter(Boolean) as string[]),
  );

  for (const row of rows) {
    try {
      const tier = row.escalation_tier ?? 0;
      const slaHours = TIER_HOURS[tier];
      if (slaHours == null) continue;
      const referenceTs = row.last_escalated_at ?? row.created_at;
      if (hoursSince(referenceTs) < slaHours) continue;

      const payload = { ...(row.payload ?? {}) } as Record<string, unknown>;
      const projectId = typeof payload.project_id === "string" ? payload.project_id : null;
      const activityId = typeof payload.activity_id === "string" ? payload.activity_id : null;

      // 1. Re-run the lightweight investigate: refresh days_over + status.
      let freshDaysOver = typeof payload.days_over === "number" ? payload.days_over : 0;
      let activityStatus: string | null = null;
      let assigneeId: string | null = null;
      if (activityId) {
        const { data: act } = await supabaseAdmin
          .from("activities")
          .select("status, due_date, assignee_id")
          .eq("id", activityId)
          .maybeSingle();
        if (act) {
          activityStatus = act.status ?? null;
          assigneeId = act.assignee_id ?? null;
          if (act.due_date) {
            freshDaysOver = Math.max(
              0,
              Math.floor((Date.now() - new Date(act.due_date).getTime()) / 86_400_000),
            );
          }
        }
      }

      // Auto-close if the underlying activity is completed / cancelled.
      if (activityStatus === "completed" || activityStatus === "cancelled") {
        await supabaseAdmin
          .from("pending_actions")
          .update({ status: "auto_closed", decided_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      // 2. Upgrade severity.
      const currentSeverity =
        (typeof payload.severity === "string" ? payload.severity : "info") as
          | "info"
          | "warning"
          | "critical";
      const nextSeverity = NEXT_SEVERITY[currentSeverity] ?? "warning";
      payload.severity = nextSeverity;
      payload.days_over = freshDaysOver;
      payload.escalation_tier = tier + 1;
      payload.last_investigated_at = new Date().toISOString();

      // 3. Determine recipients for the tier we're advancing INTO (tier+1).
      const nextTier = tier + 1;
      const recipientIds = new Set<string>();

      if (nextTier === 1) {
        // Ping assignee (project members can also inherit later tiers).
        const owner = assigneeId ?? row.assigned_to;
        if (owner) recipientIds.add(owner);
      } else if (nextTier === 2 && projectId) {
        // Project-scoped admins: project owner + members with admin role.
        const { data: proj } = await supabaseAdmin
          .from("projects")
          .select("owner_id")
          .eq("id", projectId)
          .maybeSingle();
        if (proj?.owner_id) recipientIds.add(proj.owner_id);
        const { data: members } = await supabaseAdmin
          .from("project_members")
          .select("user_id")
          .eq("project_id", projectId);
        const memberIds = (members ?? []).map((m) => m.user_id).filter(Boolean) as string[];
        if (memberIds.length > 0) {
          const { data: adminRoles } = await supabaseAdmin
            .from("user_roles")
            .select("user_id")
            .in("user_id", memberIds)
            .eq("role", "admin");
          for (const r of adminRoles ?? []) {
            if (r.user_id) recipientIds.add(r.user_id);
          }
        }
        // Fallback: if no project admins found, escalate straight to super.
        if (recipientIds.size === 0) {
          for (const id of superAdminIds) recipientIds.add(id);
        }
      } else if (nextTier >= 3) {
        for (const id of superAdminIds) recipientIds.add(id);
      }

      // 4. Insert notifications.
      const title = row.title ?? row.summary ?? "Proposal awaiting decision";
      const tierLabel =
        nextTier === 1 ? "owner" : nextTier === 2 ? "project admins" : "super admins";
      const body =
        `Auto-escalated to ${tierLabel}. Severity now ${nextSeverity.toUpperCase()}.` +
        (freshDaysOver ? ` Underlying activity ${freshDaysOver}d overdue.` : "") +
        ` Awaiting decision for ${Math.round(hoursSince(referenceTs))}h.`;
      if (recipientIds.size > 0) {
        const notifRows = Array.from(recipientIds).map((uid) => ({
          user_id: uid,
          kind: "escalation",
          title: `Escalation: ${title}`,
          body,
          activity_id: activityId,
          project_id: projectId,
        }));
        const { error: nErr, count } = await supabaseAdmin
          .from("notifications")
          .insert(notifRows as never, { count: "exact" });
        if (nErr) errors.push(`notify ${row.id}: ${nErr.message}`);
        else notifCount += count ?? notifRows.length;
      }

      // 5. Stamp the row.
      const { error: uErr } = await supabaseAdmin
        .from("pending_actions")
        .update({
          payload: payload as never,
          escalation_tier: nextTier,
          escalation_count: (row.escalation_count ?? 0) + 1,
          last_escalated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (uErr) {
        errors.push(`update ${row.id}: ${uErr.message}`);
        continue;
      }
      escalatedCount += 1;
    } catch (e) {
      errors.push(`row ${row.id}: ${(e as Error).message}`);
    }
  }

  return {
    scanned: rows.length,
    escalated: escalatedCount,
    notifications: notifCount,
    errors,
  };
}
