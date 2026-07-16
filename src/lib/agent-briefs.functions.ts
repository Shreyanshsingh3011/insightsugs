// Decision-ready briefs for the agent:
//   - summarizeThread(kind, id)     → concern/alert thread + linked docs → AI brief
//   - generateStatusReport(project) → project status snapshot → HTML brief + optional email
//
// Both are auth-scoped: they query through the RLS-scoped supabase client on
// context so users only see threads/projects they're allowed to read.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// ---------- helpers ----------

async function aiSummarize(system: string, user: string): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return "";
  try {
    const [{ generateText }, { createLovableAiGatewayProvider }] = await Promise.all([
      import("ai"),
      import("@/lib/ai-gateway.server"),
    ]);
    const gateway = createLovableAiGatewayProvider(key);
    const { text } = await generateText({
      model: gateway("google/gemini-2.5-flash"),
      system,
      prompt: user,
    });
    return (text ?? "").trim();
  } catch (e) {
    return `(AI summary unavailable: ${(e as Error).message})`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// ---------- summarizeThread ----------

const SummarizeInput = z.object({
  kind: z.enum(["concern", "alert"]),
  id: z.string().uuid(),
  // "keyword": ilike name/summary on activity keyword only (default).
  // "expanded": also match participant names, project label, and severity
  //             keywords — broader recall, may add noise.
  matchMode: z.enum(["keyword", "expanded"]).optional().default("keyword"),
});


export type ThreadBrief = {
  ok: true;
  kind: "concern" | "alert";
  id: string;
  title: string;
  status: string;
  severity: string | null;
  participants: Array<{ id: string; name: string; role: "raiser" | "responder" | "recipient" }>;
  message_count: number;
  linked_docs: Array<{ id: string; name: string; summary: string | null }>;
  brief: string;      // AI-generated decision brief
  bullets: string[];  // 3-6 key points
  recommended_decision: string;
};

export const summarizeThread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SummarizeInput.parse(input))
  .handler(async ({ data, context }): Promise<ThreadBrief | { ok: false; error: string }> => {
    const { summarizeThreadCore } = await import("@/lib/agent-briefs-core.server");
    const res = await summarizeThreadCore(context.supabase, {
      kind: data.kind,
      id: data.id,
      matchMode: data.matchMode,
    });
    if (!res.ok) return res;
    // Drop the internal-only `match_mode` field to keep the public ThreadBrief
    // shape backwards-compatible.
    const { match_mode: _mm, ...rest } = res;
    return rest;
  });


// ---------- generateStatusReport ----------

const StatusInput = z.object({
  project_id: z.string().uuid(),
  send_email: z.boolean().optional(),
  recipient_email: z.string().email().optional(),
});

export type StatusReport = {
  ok: true;
  project: { id: string; name: string };
  generated_at: string;
  totals: {
    activities: number;
    completed: number;
    overdue: number;
    blocked: number;
    open_alerts: number;
    open_concerns: number;
  };
  top_overdue: Array<{ title: string; days_over: number; assignee: string | null }>;
  brief: string;
  html: string;
  email:
    | {
        queued: boolean;
        message_id?: string;
        reason?: string;
        idempotency_key?: string;
      }
    | null;
  idempotency_key: string;

};

export const generateStatusReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => StatusInput.parse(input))
  .handler(async ({ data, context }): Promise<StatusReport | { ok: false; error: string }> => {
    const { supabase, userId } = context;

    const { data: project, error: pErr } = await supabase
      .from("projects")
      .select("id, name")
      .eq("id", data.project_id)
      .maybeSingle();
    if (pErr || !project) return { ok: false, error: pErr?.message ?? "Project not found" };

    const today = new Date().toISOString().slice(0, 10);
    const { data: acts } = await supabase
      .from("activities")
      .select("id, title, status, due_date, assignee_id, profiles:assignee_id(full_name)")
      .eq("project_id", data.project_id)
      .limit(500);
    const rows = acts ?? [];

    const overdueRows = rows
      .filter((a) => a.status !== "completed" && a.due_date && a.due_date < today)
      .map((a) => ({
        title: a.title,
        days_over: Math.max(
          0,
          Math.floor((Date.now() - new Date(a.due_date as string).getTime()) / 86_400_000),
        ),
        assignee:
          (a as { profiles?: { full_name?: string } | null }).profiles?.full_name ?? null,
      }))
      .sort((x, y) => y.days_over - x.days_over);

    const totals = {
      activities: rows.length,
      completed: rows.filter((a) => a.status === "completed").length,
      overdue: overdueRows.length,
      blocked: rows.filter((a) => a.status === "blocked").length,
      open_alerts: 0,
      open_concerns: 0,
    };

    // Alerts / concerns: count only ones the caller can see (RLS filters).
    const { count: aCount } = await supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("status", "open");
    totals.open_alerts = aCount ?? 0;
    const { count: cCount } = await supabase
      .from("concerns")
      .select("id", { count: "exact", head: true })
      .neq("status", "resolved");
    totals.open_concerns = cCount ?? 0;

    const topOverdue = overdueRows.slice(0, 8);
    const generatedAt = new Date().toISOString();

    const aiInput = [
      `Project: ${project.name}`,
      `Snapshot at: ${generatedAt}`,
      `Totals: ${JSON.stringify(totals)}`,
      "",
      "Top overdue activities:",
      topOverdue.length
        ? topOverdue
            .map((o) => `- ${o.title} (${o.days_over}d overdue${o.assignee ? `, owner ${o.assignee}` : ""})`)
            .join("\n")
        : "(none)",
    ].join("\n");

    const brief = await aiSummarize(
      "You are a project delivery analyst. Write a crisp status report for the sponsor in 3 short paragraphs: " +
        "1) Overall health in one sentence + why. " +
        "2) The 2-3 most important risks (name owners, day counts). " +
        "3) Recommended next actions this week. Plain text, no markdown headings.",
      aiInput,
    );

    // Compose HTML.
    const rowsHtml = topOverdue.length
      ? topOverdue
          .map(
            (o) =>
              `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(o.title)}</td>` +
              `<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">${o.days_over}d</td>` +
              `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${esc(o.assignee ?? "—")}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="3" style="padding:12px;color:#666;">No overdue activities.</td></tr>`;

    const html = `
<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:24px;">
  <h1 style="margin:0 0 4px 0;font-size:20px;">${esc(project.name)} — Status Report</h1>
  <p style="color:#666;margin:0 0 20px 0;font-size:13px;">Generated ${esc(generatedAt.replace("T", " ").slice(0, 16))} UTC</p>
  <table style="border-collapse:collapse;margin-bottom:20px;font-size:14px;">
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Activities</td><td><strong>${totals.activities}</strong></td>
        <td style="padding:4px 12px 4px 24px;color:#666;">Completed</td><td><strong>${totals.completed}</strong></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Overdue</td><td><strong>${totals.overdue}</strong></td>
        <td style="padding:4px 12px 4px 24px;color:#666;">Blocked</td><td><strong>${totals.blocked}</strong></td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#666;">Open alerts</td><td><strong>${totals.open_alerts}</strong></td>
        <td style="padding:4px 12px 4px 24px;color:#666;">Open concerns</td><td><strong>${totals.open_concerns}</strong></td></tr>
  </table>
  <h2 style="font-size:15px;margin:24px 0 8px 0;">Executive brief</h2>
  <div style="white-space:pre-wrap;font-size:14px;line-height:1.55;">${esc(brief)}</div>
  <h2 style="font-size:15px;margin:24px 0 8px 0;">Top overdue</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead><tr>
      <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Activity</th>
      <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd;">Overdue</th>
      <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;">Owner</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body></html>`.trim();

    // Idempotency key ties every send for this project+hour together so
    // repeated clicks don't spam recipients and the UI can look up delivery
    // status later via email_send_log.metadata.idempotency_key.
    const idempotencyKey = `status-report:${project.id}:${generatedAt.slice(0, 13)}`;

    // Optionally email.
    let emailResult: StatusReport["email"] = null;
    if (data.send_email) {
      let recipient = data.recipient_email;
      if (!recipient) {
        const { data: me } = await supabase
          .from("profiles")
          .select("email")
          .eq("id", userId)
          .maybeSingle();
        recipient = me?.email ?? undefined;
      }
      if (!recipient) {
        emailResult = { queued: false, reason: "no recipient", idempotency_key: idempotencyKey };
      } else {
        const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
        const res = await enqueueAppEmail({
          templateName: "agent-notification",
          recipientEmail: recipient,
          idempotencyKey,
          templateData: {
            subject: `Status report — ${project.name}`,
            senderName: "Insight Agent",
            recipientName: null,
            context: project.name,
            message: brief,
            reasonWhy:
              `Snapshot: ${totals.activities} activities · ${totals.overdue} overdue · ` +
              `${totals.open_alerts} open alerts.`,
          },
        });
        emailResult =
          "ok" in res && res.ok
            ? { queued: true, message_id: res.messageId, idempotency_key: idempotencyKey }
            : {
                queued: false,
                reason: "reason" in res ? res.reason : "failed",
                idempotency_key: idempotencyKey,
              };
      }
    }

    return {
      ok: true,
      project: { id: project.id, name: project.name },
      generated_at: generatedAt,
      totals,
      top_overdue: topOverdue,
      brief,
      html,
      email: emailResult,
      idempotency_key: idempotencyKey,
    };
  });

// ---------- Helpers used by the status-report dashboard dialog ----------

// List candidate recipients for a project's status report (project owner +
// members + assignees on its activities). Auth-scoped via RLS.
export const listStatusReportRecipients = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ project_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const ids = new Set<string>();

    const { data: proj } = await supabase
      .from("projects")
      .select("owner_id")
      .eq("id", data.project_id)
      .maybeSingle();
    if (proj?.owner_id) ids.add(proj.owner_id);

    const { data: members } = await supabase
      .from("project_members")
      .select("user_id")
      .eq("project_id", data.project_id);
    for (const m of members ?? []) if (m.user_id) ids.add(m.user_id);

    const { data: acts } = await supabase
      .from("activities")
      .select("assignee_id")
      .eq("project_id", data.project_id);
    for (const a of acts ?? []) if (a.assignee_id) ids.add(a.assignee_id);

    if (ids.size === 0) return { recipients: [] as Array<{ id: string; name: string; email: string }> };
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", Array.from(ids));
    return {
      recipients: (profs ?? [])
        .filter((p) => p.email)
        .map((p) => ({ id: p.id, name: p.full_name ?? p.email, email: p.email as string })),
    };
  });

// Look up the latest delivery attempt for a status-report send by the
// idempotency key we stored in email_send_log.metadata.
export const getStatusReportDelivery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ idempotency_key: z.string().min(4) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows } = await supabase
      .from("email_send_log")
      .select("message_id, status, recipient_email, error_message, created_at, metadata")
      .contains("metadata", { idempotency_key: data.idempotency_key } as never)
      .order("created_at", { ascending: false })
      .limit(10);
    const entries = (rows ?? []).map((r) => ({
      message_id: r.message_id,
      status: r.status,
      recipient: r.recipient_email,
      error: r.error_message,
      created_at: r.created_at,
    }));
    return { entries };
  });

