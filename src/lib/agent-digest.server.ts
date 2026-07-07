// Morning digest of agent-queued proposals from the last 24h.
// Emails super admins via the Lovable app email queue, and optionally posts
// to Slack if a Slack connector is linked (SLACK_API_KEY env present).
//
// Intended caller: /api/public/agent-digest (pg_cron).

const WINDOW_HOURS = 24;
const SITE_URL = "https://insightsugs.lovable.app";

type ProposalRow = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  rationale: string | null;
  created_at: string;
  payload: Record<string, unknown> | null;
};

export async function runAgentDigest(): Promise<{
  proposals: number;
  emails_queued: number;
  slack_posted: boolean;
  errors: string[];
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const errors: string[] = [];
  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  // 1. Pull agent-initiated pending proposals in the window.
  const { data: pRows, error: pErr } = await supabaseAdmin
    .from("pending_actions")
    .select("id, kind, title, summary, rationale, created_at, payload")
    .eq("status", "pending")
    .is("proposed_by", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (pErr) {
    errors.push(`pending_actions read: ${pErr.message}`);
    return { proposals: 0, emails_queued: 0, slack_posted: false, errors };
  }

  const proposals: ProposalRow[] = (pRows ?? []) as ProposalRow[];
  if (proposals.length === 0) {
    return { proposals: 0, emails_queued: 0, slack_posted: false, errors };
  }

  // 2. Super admin emails.
  const { data: admins, error: adminErr } = await supabaseAdmin.rpc(
    "list_super_admin_emails",
  );
  if (adminErr) errors.push(`list_super_admin_emails: ${adminErr.message}`);
  const recipients: Array<{ email: string; full_name: string | null }> =
    (admins ?? []).filter((r: { email?: string }) => r.email && r.email.includes("@"));

  // 3. Enqueue one email per recipient (idempotent per calendar day).
  const day = new Date().toISOString().slice(0, 10);
  let emailsQueued = 0;
  if (recipients.length > 0) {
    const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
    for (const r of recipients) {
      try {
        await enqueueAppEmail({
          templateName: "agent-morning-digest",
          recipientEmail: r.email,
          idempotencyKey: `agent-digest-${day}-${r.email}`,
          templateData: {
            recipientName: r.full_name ?? "there",
            windowHours: WINDOW_HOURS,
            proposals: proposals.slice(0, 20).map((p) => ({
              title: p.title,
              summary: p.summary,
              rationale: p.rationale ?? "",
              kind: p.kind,
              reviewUrl: `${SITE_URL}/agent/approvals?id=${p.id}`,
            })),
            totalCount: proposals.length,
            approvalsUrl: `${SITE_URL}/agent/approvals`,
          },
        });
        emailsQueued += 1;
      } catch (e) {
        errors.push(`email ${r.email}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // 4. Optional Slack post — only if a Slack connector is linked.
  let slackPosted = false;
  const slackKey = process.env.SLACK_API_KEY;
  const lovableKey = process.env.LOVABLE_API_KEY;
  const slackChannel = process.env.SLACK_DIGEST_CHANNEL; // e.g. "#delaylens"
  if (slackKey && lovableKey && slackChannel) {
    try {
      const bySeverity = proposals.reduce<Record<string, number>>((acc, p) => {
        const sev = (p.payload as { severity?: string } | null)?.severity ?? "info";
        acc[sev] = (acc[sev] ?? 0) + 1;
        return acc;
      }, {});
      const blocks = [
        {
          type: "header",
          text: { type: "plain_text", text: `DelayLens · ${proposals.length} proposals awaiting approval` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `Overnight scan queued *${proposals.length}* proposals in the last ${WINDOW_HOURS}h.\n` +
              `• Critical: ${bySeverity.critical ?? 0}\n` +
              `• Warning: ${bySeverity.warning ?? 0}\n` +
              `• Info: ${bySeverity.info ?? 0}\n\n<${SITE_URL}/agent/approvals|Open Approvals →>`,
          },
        },
        ...proposals.slice(0, 8).map((p) => ({
          type: "section" as const,
          text: {
            type: "mrkdwn" as const,
            text: `*${p.title}*\n${p.summary}\n_${p.rationale ?? ""}_`,
          },
        })),
      ];
      const resp = await fetch(
        "https://connector-gateway.lovable.dev/slack/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableKey}`,
            "X-Connection-Api-Key": slackKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ channel: slackChannel, text: `DelayLens digest — ${proposals.length} proposals`, blocks }),
        },
      );
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || (body as { ok?: boolean }).ok === false) {
        errors.push(`slack: ${resp.status} ${JSON.stringify(body)}`);
      } else {
        slackPosted = true;
      }
    } catch (e) {
      errors.push(`slack post: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    proposals: proposals.length,
    emails_queued: emailsQueued,
    slack_posted: slackPosted,
    errors,
  };
}
