// Autonomous "agent tick" loop.
//
// Scans overdue activities across every project the service role can see,
// runs the same lightweight investigateDelay logic the copilot exposes, and
// queues a pending_action of kind 'create_alert' per top offender for human
// approval at /agent/approvals. Idempotent within a 24h window using a
// hashed idempotency key on the payload.
//
// Intended caller: /api/public/agent-tick (pg_cron).

import { createHash } from "node:crypto";

const MAX_TOTAL = 25; // hard cap per tick
const MAX_PER_PROJECT = 5; // fairness cap per project
const DEDUPE_WINDOW_HOURS = 24;

type OverdueRow = {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: string;
  tat_days: number | null;
  due_date: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  days_over: number;
};

function idemKey(input: { activity_id: string; kind: string }): string {
  return createHash("sha256")
    .update(`${input.kind}:${input.activity_id}`)
    .digest("hex")
    .slice(0, 32);
}

function severityFor(daysOver: number): "info" | "warning" | "critical" {
  if (daysOver > 10) return "critical";
  if (daysOver > 3) return "warning";
  return "info";
}

export async function runAgentTick(): Promise<{
  scanned: number;
  queued: number;
  skipped_duplicates: number;
  errors: string[];
  run_id: string | null;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const errors: string[] = [];

  // 1. Log a run for observability.
  const { data: runRow } = await supabaseAdmin
    .from("agent_runs")
    .insert({
      agent: "chatbot:autonomous-tick",
      trigger: "cron",
      status: "running",
      input: { source: "agent-tick", started_at: new Date().toISOString() } as never,
    })
    .select("id")
    .single();
  const runId: string | null = runRow?.id ?? null;

  // 2. Fetch overdue activities across all projects the service role sees.
  const today = new Date().toISOString().slice(0, 10);
  const { data: acts, error: aErr } = await supabaseAdmin
    .from("activities")
    .select(
      "id, project_id, title, status, tat_days, due_date, assignee_id, projects(name), profiles:assignee_id(full_name)",
    )
    .or(`status.eq.overdue,and(due_date.lt.${today},status.in.(pending,in_progress,blocked))`)
    .limit(500);

  if (aErr) {
    errors.push(`activities scan: ${aErr.message}`);
    if (runId) {
      await supabaseAdmin
        .from("agent_runs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error: aErr.message })
        .eq("id", runId);
    }
    return { scanned: 0, queued: 0, skipped_duplicates: 0, errors, run_id: runId };
  }

  const rows: OverdueRow[] = (acts ?? []).map((a) => {
    const due = a.due_date ? new Date(a.due_date) : null;
    const daysOver = due
      ? Math.max(0, Math.floor((Date.now() - due.getTime()) / 86_400_000))
      : 0;
    return {
      id: a.id,
      project_id: a.project_id,
      project_name:
        (a as { projects?: { name?: string } | null }).projects?.name ?? "Unknown project",
      title: a.title,
      status: (a.status ?? "overdue") as string,
      tat_days: a.tat_days,
      due_date: a.due_date,
      assignee_id: a.assignee_id,
      assignee_name:
        (a as { profiles?: { full_name?: string } | null }).profiles?.full_name ?? null,
      days_over: daysOver,
    };
  });

  // 3. Rank: highest days_over first, cap per-project, then overall.
  rows.sort((a, b) => b.days_over - a.days_over);
  const perProject = new Map<string, number>();
  const candidates: OverdueRow[] = [];
  for (const r of rows) {
    if (candidates.length >= MAX_TOTAL) break;
    const n = perProject.get(r.project_id) ?? 0;
    if (n >= MAX_PER_PROJECT) continue;
    perProject.set(r.project_id, n + 1);
    candidates.push(r);
  }

  // 4. Dedupe against recent pending_actions.
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: recent } = await supabaseAdmin
    .from("pending_actions")
    .select("payload, created_at")
    .gte("created_at", since)
    .eq("kind", "create_alert");
  const recentKeys = new Set<string>(
    (recent ?? [])
      .map((r) => {
        const p = r.payload as { idem?: string } | null;
        return p?.idem ?? "";
      })
      .filter(Boolean),
  );

  // 5. Queue proposals.
  let queued = 0;
  let skipped = 0;
  const inserts: Array<Record<string, unknown>> = [];
  for (const r of candidates) {
    const kind = "create_alert";
    const idem = idemKey({ activity_id: r.id, kind });
    if (recentKeys.has(idem)) {
      skipped += 1;
      continue;
    }
    const severity = severityFor(r.days_over);
    const summary = `${severity.toUpperCase()} — ${r.title} (${r.project_name})${
      r.assignee_name ? ` · owner ${r.assignee_name}` : ""
    }`;
    const rationale =
      `${r.days_over} days overdue` +
      (r.tat_days ? ` (TAT ${r.tat_days}d)` : "") +
      (r.assignee_name
        ? `. Suggested action: ${severity === "critical" ? "escalate + email owner" : severity === "warning" ? "nudge owner + schedule standup" : "monitor"}.`
        : ". No assignee — needs owner assignment first.");
    inserts.push({
      kind,
      title: `Alert: ${r.title}`,
      summary,
      rationale,
      status: "pending",
      proposed_by: null, // null = agent-initiated
      run_id: runId,
      payload: {
        source: "agent-tick",
        idem,
        activity_id: r.id,
        activity: r.title,
        project_id: r.project_id,
        project: r.project_name,
        person: r.assignee_name,
        severity,
        reason: rationale,
        days_over: r.days_over,
        due_date: r.due_date,
      },
    });
    queued += 1;
  }

  if (inserts.length > 0) {
    const { error: iErr } = await supabaseAdmin.from("pending_actions").insert(inserts as never);
    if (iErr) errors.push(`insert pending_actions: ${iErr.message}`);
  }

  // 6. Finalise run.
  if (runId) {
    await supabaseAdmin
      .from("agent_runs")
      .update({
        status: errors.length > 0 ? "failed" : "succeeded",
        finished_at: new Date().toISOString(),
        output: {
          scanned: rows.length,
          queued,
          skipped_duplicates: skipped,
          errors,
        } as never,
      })
      .eq("id", runId);
  }

  return { scanned: rows.length, queued, skipped_duplicates: skipped, errors, run_id: runId };
}
