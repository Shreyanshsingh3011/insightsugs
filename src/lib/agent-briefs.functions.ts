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
      model: gateway("google/gemini-3-flash-preview"),
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
    const { supabase } = context;

    let title = "";
    let status = "";
    let severity: string | null = null;
    let bodyText = "";
    let activityHint = "";
    const participants: ThreadBrief["participants"] = [];
    const messagesRaw: Array<{ author_id: string; body: string; created_at: string }> = [];

    if (data.kind === "concern") {
      const { data: c, error } = await supabase
        .from("concerns")
        .select("id, title, body, status, severity, activity, raised_by, acknowledged_by, resolved_by")
        .eq("id", data.id)
        .maybeSingle();
      if (error || !c) return { ok: false, error: error?.message ?? "Concern not found" };
      title = c.title;
      status = c.status;
      severity = c.severity;
      bodyText = c.body ?? "";
      activityHint = c.activity ?? "";
      const ids = [c.raised_by, c.acknowledged_by, c.resolved_by].filter(Boolean) as string[];
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
        for (const p of profs ?? []) {
          const role: "raiser" | "responder" =
            p.id === c.raised_by ? "raiser" : "responder";
          participants.push({ id: p.id, name: p.full_name ?? "Unknown", role });
        }
      }
      const { data: msgs } = await supabase
        .from("concern_messages")
        .select("author_id, body, created_at")
        .eq("concern_id", data.id)
        .order("created_at", { ascending: true })
        .limit(200);
      messagesRaw.push(...(msgs ?? []));
    } else {
      const { data: a, error } = await supabase
        .from("alerts")
        .select("id, activity, reason, root_cause, status, severity, sent_by, resolved_by")
        .eq("id", data.id)
        .maybeSingle();
      if (error || !a) return { ok: false, error: error?.message ?? "Alert not found" };
      title = `Alert: ${a.activity}`;
      status = a.status;
      severity = a.severity;
      bodyText = [a.reason, a.root_cause].filter(Boolean).join("\n\n");
      activityHint = a.activity ?? "";
      const ids = [a.sent_by, a.resolved_by].filter(Boolean) as string[];
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, full_name").in("id", ids);
        for (const p of profs ?? []) {
          participants.push({
            id: p.id,
            name: p.full_name ?? "Unknown",
            role: p.id === a.sent_by ? "raiser" : "responder",
          });
        }
      }
      const { data: recips } = await supabase
        .from("alert_recipients")
        .select("user_id, profiles:user_id(full_name)")
        .eq("alert_id", data.id);
      for (const r of recips ?? []) {
        if (!r.user_id) continue;
        participants.push({
          id: r.user_id,
          name:
            (r as { profiles?: { full_name?: string } }).profiles?.full_name ?? "Recipient",
          role: "recipient",
        });
      }
      const { data: msgs } = await supabase
        .from("alert_messages")
        .select("author_id, body, created_at")
        .eq("alert_id", data.id)
        .order("created_at", { ascending: true })
        .limit(200);
      messagesRaw.push(...(msgs ?? []));
    }

    // Resolve message authors → names.
    const authorIds = Array.from(new Set(messagesRaw.map((m) => m.author_id)));
    const nameById = new Map<string, string>();
    if (authorIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", authorIds);
      for (const p of profs ?? []) nameById.set(p.id, p.full_name ?? "Unknown");
    }
    const messages = messagesRaw.map((m) => ({
      name: nameById.get(m.author_id) ?? "Unknown",
      body: m.body,
      created_at: m.created_at,
    }));

    // Linked docs: best-effort keyword match on document name / summary.
    let linked: ThreadBrief["linked_docs"] = [];
    const needle = (activityHint || title).trim().slice(0, 60);
    if (needle) {
      const { data: docs } = await supabase
        .from("documents")
        .select("id, name, summary")
        .or(`name.ilike.%${needle}%,summary.ilike.%${needle}%`)
        .limit(5);
      linked = (docs ?? []).map((d) => ({ id: d.id, name: d.name, summary: d.summary }));
    }

    // Build AI prompt.
    const transcript = messages
      .map((m) => `- [${m.created_at.slice(0, 16).replace("T", " ")}] ${m.name}: ${m.body}`)
      .join("\n");
    const docsBlock = linked.length
      ? linked.map((d) => `- ${d.name}${d.summary ? ` — ${d.summary.slice(0, 240)}` : ""}`).join("\n")
      : "(no linked documents)";
    const userMsg = [
      `${data.kind.toUpperCase()}: ${title}`,
      `Status: ${status}${severity ? ` · Severity: ${severity}` : ""}`,
      activityHint ? `Related activity: ${activityHint}` : "",
      "",
      "Original description:",
      bodyText || "(none)",
      "",
      "Thread transcript:",
      transcript || "(no replies yet)",
      "",
      "Linked documents:",
      docsBlock,
    ]
      .filter(Boolean)
      .join("\n");

    const brief = await aiSummarize(
      "You are a project delivery analyst. Produce a decision-ready brief for a manager who has 60 seconds. " +
        "Structure the response as three plain-text sections separated by blank lines: " +
        "1) BRIEF: 2-3 sentence summary of the situation and where it stands. " +
        "2) KEY POINTS: 3-6 short bullets starting with '- '. " +
        "3) RECOMMENDED DECISION: one sentence with a clear action. " +
        "Cite specific names, dates, and numbers. Do not invent facts.",
      userMsg,
    );

    // Parse sections defensively.
    const sections = brief.split(/\n\s*\n/);
    const briefPart =
      sections.find((s) => /BRIEF/i.test(s))?.replace(/^[^:]*:\s*/i, "").trim() ??
      sections[0]?.trim() ??
      "";
    const bulletsPart = sections.find((s) => /KEY POINTS|BULLETS/i.test(s)) ?? "";
    const bullets = bulletsPart
      .split("\n")
      .map((l) => l.replace(/^[-*•]\s*/, "").trim())
      .filter((l) => l && !/KEY POINTS|BULLETS/i.test(l));
    const decision =
      sections
        .find((s) => /RECOMMEND|DECISION/i.test(s))
        ?.replace(/^[^:]*:\s*/i, "")
        .trim() ?? "";

    return {
      ok: true,
      kind: data.kind,
      id: data.id,
      title,
      status,
      severity,
      participants,
      message_count: messages.length,
      linked_docs: linked,
      brief: briefPart,
      bullets,
      recommended_decision: decision,
    };
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
  email: { queued: boolean; message_id?: string; reason?: string } | null;
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
        emailResult = { queued: false, reason: "no recipient" };
      } else {
        const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
        const res = await enqueueAppEmail({
          templateName: "agent-notification",
          recipientEmail: recipient,
          idempotencyKey: `status-report:${project.id}:${generatedAt.slice(0, 13)}`,
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
            ? { queued: true, message_id: res.messageId }
            : { queued: false, reason: "reason" in res ? res.reason : "failed" };
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
    };
  });
