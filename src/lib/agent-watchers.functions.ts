// Agent Watchers — deterministic rule engine that scans the same live sheet
// export the dashboard reads, and materialises actionable drafts into
// public.agent_drafts. All inserts go through supabaseAdmin because the
// table intentionally has no INSERT policy for authenticated users (drafts
// must originate on the server so the queue stays trustworthy).
//
// Callable from:
//   1. The Agent Inbox "Refresh drafts" button (authenticated user).
//   2. /api/public/hooks/agent-watchers (pg_cron / external scheduler).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ── Types ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export type WatcherRunResult = {
  projects_scanned: number;
  rows_scanned: number;
  created: number;
  skipped_dedupe: number;
  errors: string[];
  by_rule: Record<string, number>;
};

// ── Row helpers (mirror src/lib/entity-scope.ts) ───────────────────────

function pick(r: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}
function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function isCompleted(status: string) {
  return /complete|done|closed/i.test(status);
}

// ── URL safety (same as insights-proxy) ────────────────────────────────

function assertSafePublicUrl(raw: string): URL {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const localApi = url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1") && url.pathname.startsWith("/api/public/");
  if (url.protocol !== "https:" && !localApi) throw new Error("Only https links are supported.");
  if (localApi) return url;
  if (
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) throw new Error("Only public analytics links are supported.");
  return url;
}

async function fetchPayload(url: string): Promise<Row[]> {
  const u = assertSafePublicUrl(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25_000);
  try {
    const res = await fetch(u.toString(), { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Row[] };
    return Array.isArray(json?.data) ? json.data : [];
  } finally { clearTimeout(t); }
}

// ── Rule engine ────────────────────────────────────────────────────────

type DraftSeed = {
  draft_type: "nudge" | "escalation" | "root_cause_ask" | "status_update";
  source_kind: string;
  source_key: string;
  title: string;
  subject: string;
  body: string;
  channel: "direct_message" | "email";
  recipient_email: string | null;
  confidence: number;
  why: string;
  payload: Record<string, unknown>;
  created_by_rule: string;
  // used later to resolve assigned_to
  _recipient_email_norm: string | null;
};

function ruleSeeds(row: Row, projectLabel: string): DraftSeed[] {
  const seeds: DraftSeed[] = [];
  const status = pick(row, "Status Category", "Status as on Date");
  if (isCompleted(status)) return seeds;

  const activity = pick(row, "Activity List", "Process Descriptions", "Process") || "(unnamed activity)";
  const stage    = pick(row, "Stages", "Stages of Process") || "—";
  const person   = pick(row, "Responsible Person", "Responsibility", "approvers name") || "the responsible person";
  const email    = pick(row, "Responsible Person Mail ID", "approvers email id").toLowerCase() || null;
  const srNo     = pick(row, "Sr. No.", "Sr No", "ID", "Id", "S.No", "SNo");
  const delay    = num(row["Delay in Days"]);
  const tat      = num(row["TAT"]);
  const taken    = num(row["Days Taken"]);
  const crit     = pick(row, "Criticality").toLowerCase();
  const reason   = pick(row, "Delay Reason", "Reason for Delay");

  const sourceKey = `${projectLabel}::${srNo || activity}`.slice(0, 400);
  const firstName = person.split(/\s+/)[0] || "there";
  const ctxLine   = `Project: ${projectLabel} · Stage: ${stage} · Activity: ${activity}${srNo ? ` (Sr ${srNo})` : ""}`;
  const channel: DraftSeed["channel"] = email ? "direct_message" : "direct_message";
  const basePayload = { project: projectLabel, stage, activity, srNo, status, delay, tat, taken, criticality: crit, reason };

  // Rule 1 — Overdue task (delay > 2 days, not completed)
  if (delay >= 3 && delay < 10) {
    seeds.push({
      draft_type: "nudge",
      source_kind: "row.overdue",
      source_key: sourceKey,
      title: `${activity} — ${delay}d overdue · ${projectLabel}`,
      subject: `Nudge: ${activity} is ${delay} days overdue`,
      body: [
        `Hi ${firstName},`,
        "",
        `${activity} on ${projectLabel} (${stage}) is currently ${delay} days past plan. Status: ${status || "—"}.`,
        reason ? `Recorded delay reason: ${reason}.` : "",
        "",
        "Could you share the latest status and a committed recovery date today?",
        "",
        "Thanks.",
      ].filter(Boolean).join("\n"),
      channel,
      recipient_email: email,
      confidence: Math.min(0.9, 0.55 + delay * 0.03),
      why: `Delay in Days = ${delay}, status "${status || "open"}", not marked complete.`,
      payload: { ...basePayload, rule: "overdue" },
      created_by_rule: "watcher:overdue",
      _recipient_email_norm: email,
    });
  }

  // Rule 2 — Escalation (delay ≥ 10 days OR High criticality with delay ≥ 5)
  if (delay >= 10 || (/high|critical/.test(crit) && delay >= 5)) {
    seeds.push({
      draft_type: "escalation",
      source_kind: "row.escalation",
      source_key: sourceKey,
      title: `Escalation: ${activity} · ${delay}d · ${projectLabel}`,
      subject: `Escalation — ${activity} (${delay}d overdue)`,
      body: [
        `Hi ${firstName},`,
        "",
        `Escalating: ${activity} on ${projectLabel} (${stage}) is ${delay} days past plan${crit ? ` and marked ${crit} criticality` : ""}. Status: ${status || "—"}.`,
        reason ? `Latest delay reason on record: ${reason}.` : "",
        "",
        "Please confirm today: (1) blocker, (2) owner-side action, (3) new committed date.",
        "",
        "Thanks.",
      ].filter(Boolean).join("\n"),
      channel,
      recipient_email: email,
      confidence: Math.min(0.95, 0.7 + Math.min(delay, 30) * 0.01),
      why: `Delay ${delay}d${crit ? `, criticality ${crit}` : ""}, still ${status || "open"}.`,
      payload: { ...basePayload, rule: "escalation" },
      created_by_rule: "watcher:escalation",
      _recipient_email_norm: email,
    });
  }

  // Rule 3 — TAT slip (taken >> tat)
  if (tat > 0 && taken > tat * 1.5 && taken - tat >= 3) {
    seeds.push({
      draft_type: "root_cause_ask",
      source_kind: "row.tat_slip",
      source_key: sourceKey,
      title: `TAT slip: ${activity} — ${taken}d vs ${tat}d target`,
      subject: `TAT check: ${activity}`,
      body: [
        `Hi ${firstName},`,
        "",
        `${activity} (${projectLabel} · ${stage}) has taken ${taken} days against a ${tat}-day TAT target — a ${Math.round((taken / tat - 1) * 100)}% slip.`,
        "",
        "What's driving the slip? Is there a scope or dependency change we should record?",
        "",
        "Thanks.",
      ].join("\n"),
      channel,
      recipient_email: email,
      confidence: 0.6,
      why: `Days Taken (${taken}) > 1.5 × TAT (${tat}).`,
      payload: { ...basePayload, rule: "tat_slip" },
      created_by_rule: "watcher:tat_slip",
      _recipient_email_norm: email,
    });
  }

  return seeds;
}

// ── Assignee resolution ────────────────────────────────────────────────

async function buildAssigneeResolver(supabaseAdmin: any) {
  const [{ data: profiles }, { data: supers }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, email"),
    supabaseAdmin.from("user_roles").select("user_id").eq("role", "super_admin"),
  ]);
  const emailToId = new Map<string, string>();
  for (const p of profiles ?? []) {
    const e = (p.email ?? "").toLowerCase().trim();
    if (e) emailToId.set(e, p.id);
  }
  const fallback = (supers ?? [])[0]?.user_id ?? null;
  return (email: string | null): { assigned_to: string | null; recipient_user_id: string | null } => {
    if (email) {
      const id = emailToId.get(email.toLowerCase());
      if (id) return { assigned_to: id, recipient_user_id: id };
    }
    // Unknown recipient — queue for a super admin to triage.
    return { assigned_to: fallback, recipient_user_id: null };
  };
}

// ── Core runner ────────────────────────────────────────────────────────

async function runWatchersCore(
  projects: { label: string; url: string }[],
  supabaseAdmin: any,
  runBy: string | null,
): Promise<WatcherRunResult> {
  const result: WatcherRunResult = {
    projects_scanned: 0,
    rows_scanned: 0,
    created: 0,
    skipped_dedupe: 0,
    errors: [],
    by_rule: {},
  };

  const resolve = await buildAssigneeResolver(supabaseAdmin);

  for (const proj of projects) {
    let rows: Row[] = [];
    try {
      rows = await fetchPayload(proj.url);
    } catch (e) {
      result.errors.push(`${proj.label}: ${(e as Error).message}`);
      continue;
    }
    result.projects_scanned++;
    result.rows_scanned += rows.length;

    for (const row of rows) {
      const seeds = ruleSeeds(row, proj.label);
      for (const s of seeds) {
        const { assigned_to, recipient_user_id } = resolve(s._recipient_email_norm);
        const insertRow = {
          draft_type: s.draft_type,
          source_kind: s.source_kind,
          source_key: s.source_key,
          title: s.title.slice(0, 400),
          subject: s.subject.slice(0, 400),
          body: s.body,
          channel: s.channel,
          recipient_email: s.recipient_email,
          recipient_user_id,
          cc: [],
          confidence: s.confidence,
          why: s.why,
          payload: s.payload,
          assigned_to,
          created_by_rule: s.created_by_rule,
        };
        const { error } = await supabaseAdmin.from("agent_drafts").insert(insertRow);
        if (error) {
          if ((error as any).code === "23505") {
            result.skipped_dedupe++;
          } else {
            result.errors.push(`${s.source_key}: ${error.message}`);
          }
        } else {
          result.created++;
          result.by_rule[s.created_by_rule] = (result.by_rule[s.created_by_rule] ?? 0) + 1;
        }
      }
    }
  }

  // Best-effort audit
  try {
    await supabaseAdmin.from("audit_log").insert({
      actor_id: runBy,
      event_type: "agent_watchers.run",
      details: result as unknown as Record<string, unknown>,
    });
  } catch { /* non-fatal */ }

  return result;
}

// ── Server functions ───────────────────────────────────────────────────

const RunInput = z.object({
  url: z.string().url().max(3000).optional(),
});

/**
 * runAgentWatchers — user-triggered scan. Uses the master project registry
 * (Google Sheets connector or public CSV fallback) unless a specific URL is
 * passed. Requires an authenticated caller.
 */
export const runAgentWatchers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RunInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { userId } = context as { userId: string };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let projects: { label: string; url: string }[] = [];
    if (data.url) {
      projects = [{ label: new URL(data.url).hostname, url: data.url }];
    } else {
      // Reuse the same registry fetcher the dashboard uses.
      const { fetchAgentProjects } = await import("@/lib/agent-registry.functions");
      try {
        const reg = await fetchAgentProjects();
        projects = reg.projects.map((p) => ({ label: p.label, url: p.url }));
      } catch (e) {
        return {
          projects_scanned: 0, rows_scanned: 0, created: 0, skipped_dedupe: 0,
          by_rule: {}, errors: [`registry: ${(e as Error).message}`],
        } as WatcherRunResult;
      }
    }
    return runWatchersCore(projects, supabaseAdmin, userId);
  });

/**
 * runAgentWatchersFromHook — internal helper for the cron endpoint.
 * Not exported as a server function; the API route imports it directly.
 */
export async function runAgentWatchersFromHook(): Promise<WatcherRunResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { fetchAgentProjects } = await import("@/lib/agent-registry.functions");
  // Bypass the requireSupabaseAuth middleware; call the underlying loader.
  // fetchAgentProjects is a server fn — invoking it here still works because
  // it's imported as a plain module reference on the server side.
  let projects: { label: string; url: string }[] = [];
  try {
    // @ts-expect-error — server-side invocation of the raw handler payload.
    const reg = await fetchAgentProjects();
    projects = reg.projects.map((p: any) => ({ label: p.label, url: p.url }));
  } catch (e) {
    return {
      projects_scanned: 0, rows_scanned: 0, created: 0, skipped_dedupe: 0,
      by_rule: {}, errors: [`registry: ${(e as Error).message}`],
    };
  }
  return runWatchersCore(projects, supabaseAdmin, null);
}
