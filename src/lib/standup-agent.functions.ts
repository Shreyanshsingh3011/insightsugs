// Daily Standup Agent
// Scans every registered project's live sheet for delays/blockers, drafts a
// per-project standup summary via Lovable AI, and delivers it three ways:
//   1. In-app notifications to every admin / super_admin
//   2. Transactional email to admins via the existing email queue
//   3. Direct-message follow-ups to each impacted assignee ("still blocked? ETA?")
// Also writes an `agent_drafts` row (draft_type=standup) as an audit trail.
//
// Callable from the UI (server fn) and from /api/public/hooks/daily-standup (cron).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolvePersonForRow } from "@/lib/person-resolver";

type Row = Record<string, unknown>;
type ProjectDelayItem = {
  activity: string;
  stage: string;
  srNo: string;
  status: string;
  delay: number;
  criticality: string;
  reason: string;
  assigneeEmail: string | null;
  assigneeName: string;
};
type ProjectDigest = {
  project: string;
  totalOverdue: number;
  criticalCount: number;
  items: ProjectDelayItem[];
  ai: { summary: string; blockers: string[]; asks: string[] };
};

function pick(r: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}
function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function isCompleted(status: string) { return /complete|done|closed/i.test(status); }

async function fetchProjectRows(url: string): Promise<Row[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25_000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: Row[] };
    return Array.isArray(json?.data) ? json.data : [];
  } finally { clearTimeout(t); }
}

function collectDelays(rows: Row[], directory: Map<string, string>): ProjectDelayItem[] {
  const out: ProjectDelayItem[] = [];
  for (const r of rows) {
    const status = pick(r, "Status Category", "Status as on Date", "Status");
    if (isCompleted(status)) continue;
    const delay = num(r["Delay in Days"]);
    if (delay < 3) continue;
    const resolved = resolvePersonForRow(r, directory);
    out.push({
      activity: pick(r, "Activity List", "Process Descriptions", "Process") || "(unnamed)",
      stage: pick(r, "Stages", "Stages of Process") || "—",
      srNo: pick(r, "Sr. No.", "Sr No", "ID", "Id"),
      status: status || "open",
      delay,
      criticality: pick(r, "Criticality").toLowerCase(),
      reason: pick(r, "Delay Reason", "Reason for Delay"),
      assigneeEmail: resolved.email || pick(r, "Responsible Person Mail ID").toLowerCase() || null,
      assigneeName: resolved.displayName || "the responsible person",
    });
  }
  return out.sort((a, b) => b.delay - a.delay).slice(0, 15);
}

async function aiSummary(project: string, items: ProjectDelayItem[]): Promise<ProjectDigest["ai"]> {
  const key = process.env.LOVABLE_API_KEY;
  const fallback = {
    summary: `${items.length} activities are past plan on ${project}; longest slip is ${items[0]?.delay ?? 0} days.`,
    blockers: items.slice(0, 5).map(i => `${i.activity} (${i.delay}d) — ${i.reason || "no reason recorded"}`),
    asks: items.slice(0, 5).map(i => `${i.assigneeName}: ETA on ${i.activity}?`),
  };
  if (!key) return fallback;
  const compact = items.map(i => ({
    activity: i.activity, stage: i.stage, delay: i.delay, status: i.status,
    criticality: i.criticality, reason: i.reason, owner: i.assigneeName,
  }));
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: "You write terse construction-project standups. Return JSON only." },
          { role: "user", content:
`Write today's standup for project "${project}". Return STRICT JSON:
{"summary": string (2 sentences), "blockers": string[] (max 5 concrete blockers with numbers), "asks": string[] (max 5 short follow-up questions to owners, address by first name)}
Data:
${JSON.stringify(compact).slice(0, 8000)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return fallback;
    const j: any = await res.json();
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    return {
      summary: String(parsed.summary ?? fallback.summary),
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map(String).slice(0, 5) : fallback.blockers,
      asks: Array.isArray(parsed.asks) ? parsed.asks.map(String).slice(0, 5) : fallback.asks,
    };
  } catch { return fallback; }
}

function digestToMarkdown(d: ProjectDigest): string {
  const parts = [
    `# Daily standup — ${d.project}`,
    "",
    d.ai.summary,
    "",
    `**${d.totalOverdue} overdue** · **${d.criticalCount} critical**`,
    "",
    "## Top blockers",
    ...d.ai.blockers.map(b => `- ${b}`),
    "",
    "## Follow-ups needed",
    ...d.ai.asks.map(a => `- ${a}`),
    "",
    "## Full delay list",
    ...d.items.map(i => `- **${i.activity}** (${i.stage}) — ${i.delay}d overdue · ${i.status}${i.reason ? ` · reason: ${i.reason}` : ""} — owner: ${i.assigneeName}`),
  ];
  return parts.join("\n");
}

export type StandupRunResult = {
  projects_scanned: number;
  projects_with_delays: number;
  digests: { project: string; overdue: number; critical: number }[];
  notifications: number;
  emails_queued: number;
  dms_sent: number;
  drafts_created: number;
  errors: string[];
};

async function runStandupCore(runBy: string | null): Promise<StandupRunResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { loadAgentProjects } = await import("@/lib/agent-registry.functions");

  const result: StandupRunResult = {
    projects_scanned: 0, projects_with_delays: 0, digests: [],
    notifications: 0, emails_queued: 0, dms_sent: 0, drafts_created: 0, errors: [],
  };

  let registry: { label: string; url: string }[] = [];
  try {
    const reg = await loadAgentProjects();
    registry = reg.projects.map(p => ({ label: p.label, url: p.url }));
  } catch (e) {
    result.errors.push(`registry: ${(e as Error).message}`);
    return result;
  }

  // Build directory + admin recipients + sender (system) once.
  const [{ data: profiles }, { data: adminRoles }] = await Promise.all([
    supabaseAdmin.from("profiles").select("id, email, full_name"),
    supabaseAdmin.from("user_roles").select("user_id").in("role", ["admin", "super_admin"]),
  ]);
  const directory = new Map<string, string>();
  const emailToId = new Map<string, string>();
  const idToEmail = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const p of profiles ?? []) {
    const e = (p.email ?? "").toLowerCase().trim();
    const n = (p.full_name ?? "").trim();
    if (e) directory.set(e, n);
    if (e && p.id) { emailToId.set(e, p.id); idToEmail.set(p.id, e); }
    if (p.id && n) idToName.set(p.id, n);
  }
  const adminIds = Array.from(new Set((adminRoles ?? []).map((r: any) => r.user_id).filter(Boolean)));
  const senderId = runBy ?? adminIds[0] ?? null;
  const today = new Date().toISOString().slice(0, 10);

  for (const proj of registry) {
    let rows: Row[] = [];
    try { rows = await fetchProjectRows(proj.url); }
    catch (e) { result.errors.push(`${proj.label}: ${(e as Error).message}`); continue; }
    result.projects_scanned++;
    const items = collectDelays(rows, directory);
    if (items.length === 0) continue;
    result.projects_with_delays++;
    const ai = await aiSummary(proj.label, items);
    const digest: ProjectDigest = {
      project: proj.label,
      totalOverdue: items.length,
      criticalCount: items.filter(i => /high|critical/.test(i.criticality) || i.delay >= 10).length,
      items, ai,
    };
    result.digests.push({ project: proj.label, overdue: digest.totalOverdue, critical: digest.criticalCount });
    const md = digestToMarkdown(digest);
    const idempotency = `standup-${today}-${proj.label.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`;

    // 1) audit trail as agent draft
    try {
      const { error: dErr } = await supabaseAdmin.from("agent_drafts").insert({
        draft_type: "standup",
        source_kind: "standup.daily",
        source_key: idempotency,
        title: `Standup ${today} — ${proj.label} (${digest.totalOverdue} overdue)`,
        subject: `Daily standup — ${proj.label}`,
        body: md,
        channel: "direct_message",
        confidence: 0.9,
        why: `AI summary of ${digest.totalOverdue} open delays.`,
        payload: { project: proj.label, ai, items: digest.items, generated_at: new Date().toISOString() },
        assigned_to: senderId,
        created_by_rule: "standup:daily",
      });
      if (!dErr) result.drafts_created++;
    } catch (e) { result.errors.push(`draft ${proj.label}: ${(e as Error).message}`); }

    // 2) in-app notifications for admins
    if (adminIds.length > 0) {
      const rows = adminIds.map(uid => ({
        user_id: uid,
        kind: "standup",
        title: `Standup ${today}: ${proj.label}`,
        body: `${digest.totalOverdue} overdue · ${digest.criticalCount} critical. ${ai.summary}`.slice(0, 800),
      }));
      const { error, count } = await supabaseAdmin.from("notifications").insert(rows, { count: "exact" });
      if (!error) result.notifications += count ?? rows.length;
    }

    // 3) emails to admins via the existing queue
    try {
      const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
      const adminEmails = Array.from(new Set(adminIds.map(id => idToEmail.get(id)).filter(Boolean))) as string[];
      for (const email of adminEmails) {
        const r = await enqueueAppEmail({
          templateName: "agent-notification",
          recipientEmail: email,
          idempotencyKey: `${idempotency}-${email}`,
          templateData: {
            recipientName: idToName.get(emailToId.get(email) ?? "") ?? "",
            senderName: "DelayLens Standup Bot",
            subject: `Daily standup — ${proj.label}`,
            message: md,
            context: `Project: ${proj.label} · ${digest.totalOverdue} overdue`,
            reasonWhy: `Auto-generated at ${new Date().toISOString()} from live sheet scan.`,
          },
        });
        if (r.ok) result.emails_queued++;
      }
    } catch (e) { result.errors.push(`email ${proj.label}: ${(e as Error).message}`); }

    // 4) DM follow-ups to each unique assignee
    if (senderId) {
      const byAssignee = new Map<string, ProjectDelayItem[]>();
      for (const it of digest.items) {
        const uid = it.assigneeEmail ? emailToId.get(it.assigneeEmail) : null;
        if (!uid || uid === senderId) continue;
        const arr = byAssignee.get(uid) ?? [];
        arr.push(it);
        byAssignee.set(uid, arr);
      }
      for (const [uid, myItems] of byAssignee.entries()) {
        const body = [
          `Quick standup ping for ${proj.label}:`,
          "",
          ...myItems.slice(0, 5).map(i => `• ${i.activity} — ${i.delay}d overdue${i.reason ? ` (${i.reason})` : ""}`),
          "",
          "Are these still blocked? What's the committed ETA on each?",
        ].join("\n");
        const { error } = await supabaseAdmin.from("direct_messages").insert({
          sender_id: senderId,
          recipient_id: uid,
          subject: `Standup ${today}: ${proj.label}`,
          body,
          context_kind: "standup",
          context_ref: idempotency,
        });
        if (!error) result.dms_sent++;
      }
    }
  }

  try {
    await supabaseAdmin.from("audit_log").insert({
      actor_id: runBy,
      event_type: "standup.daily.run",
      details: JSON.parse(JSON.stringify(result)),
    });
  } catch {}
  return result;
}

export const runStandupAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, supabase } = context as { userId: string; supabase: any };
    const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
    if (!isAdmin) throw new Error("Only admins can trigger the standup agent");
    return runStandupCore(userId);
  });

export async function runStandupAgentFromHook(): Promise<StandupRunResult> {
  return runStandupCore(null);
}
