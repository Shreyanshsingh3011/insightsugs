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

  // 2. Build recipient list:
  //    - super admins receive ALL proposals
  //    - admins receive only proposals whose payload.project_id belongs to a
  //      project they own or are a member of.
  const day = new Date().toISOString().slice(0, 10);
  let emailsQueued = 0;
  const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
  const { mintDigestReplyToken, replyAddressFor, subjectTagFor } = await import(
    "@/lib/agent-inbound.server"
  );

  const sendTo = async (
    userId: string,
    email: string,
    fullName: string | null,
    scopedProposals: ProposalRow[],
    scopeLabel: "all" | "scoped",
  ) => {
    if (scopedProposals.length === 0) return;
    try {
      // Mint a reply token that maps to this recipient + the exact ordered
      // proposal list they see, so "approve #3" acts on the 3rd item shown.
      const token = await mintDigestReplyToken({
        userId,
        digestKind: `daily-${scopeLabel}`,
        digestRef: day,
        pendingActionIds: scopedProposals.slice(0, 20).map((p) => p.id),
        projectIds: Array.from(
          new Set(
            scopedProposals
              .map((p) => (p.payload as { project_id?: string } | null)?.project_id)
              .filter((v): v is string => typeof v === "string"),
          ),
        ),
      });
      await enqueueAppEmail({
        templateName: "agent-morning-digest",
        recipientEmail: email,
        idempotencyKey: `agent-digest-${day}-${scopeLabel}-${email}`,
        replyTo: replyAddressFor(token),
        subjectTag: subjectTagFor(token),
        templateData: {
          recipientName: fullName ?? "there",
          windowHours: WINDOW_HOURS,
          proposals: scopedProposals.slice(0, 20).map((p, i) => ({
            index: i + 1,
            title: p.title,
            summary: p.summary,
            rationale: p.rationale ?? "",
            kind: p.kind,
            reviewUrl: `${SITE_URL}/agent/approvals?id=${p.id}`,
          })),
          totalCount: scopedProposals.length,
          approvalsUrl: `${SITE_URL}/agent/approvals`,
          replyHint: `Reply to this email with a command like "approve #2" or "why is it late?"`,
        },
      });
      emailsQueued += 1;
    } catch (e) {
      errors.push(`email ${email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 2a. Super admins — full digest.
  const { data: supers, error: superErr } = await supabaseAdmin.rpc(
    "list_super_admin_emails",
  );
  if (superErr) errors.push(`list_super_admin_emails: ${superErr.message}`);
  const superRecipients: Array<{ user_id?: string; email: string; full_name: string | null }> =
    (supers ?? []).filter((r: { email?: string }) => r.email && r.email.includes("@"));
  for (const r of superRecipients) {
    if (!r.user_id) continue;
    await sendTo(r.user_id, r.email, r.full_name, proposals, "all");
  }

  // 2b. Admins — project-scoped digest.
  const superIds = new Set<string>(
    ((supers ?? []) as Array<{ user_id?: string }>).map((r) => r.user_id ?? "").filter(Boolean),
  );
  const { data: adminRoleRows, error: adminRoleErr } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");
  if (adminRoleErr) errors.push(`admin roles: ${adminRoleErr.message}`);
  const adminIds = Array.from(
    new Set(
      ((adminRoleRows ?? []) as Array<{ user_id: string }>)
        .map((r) => r.user_id)
        .filter((id) => id && !superIds.has(id)),
    ),
  );

  if (adminIds.length > 0) {
    const { data: profs } = await supabaseAdmin
      .from("profiles")
      .select("id, email, full_name")
      .in("id", adminIds);
    const { data: owned } = await supabaseAdmin
      .from("projects")
      .select("id, owner_id")
      .in("owner_id", adminIds);
    const { data: memb } = await supabaseAdmin
      .from("project_members")
      .select("user_id, project_id")
      .in("user_id", adminIds);

    const projectsByAdmin = new Map<string, Set<string>>();
    for (const id of adminIds) projectsByAdmin.set(id, new Set());
    for (const row of (owned ?? []) as Array<{ id: string; owner_id: string }>) {
      projectsByAdmin.get(row.owner_id)?.add(row.id);
    }
    for (const row of (memb ?? []) as Array<{ user_id: string; project_id: string }>) {
      projectsByAdmin.get(row.user_id)?.add(row.project_id);
    }

    for (const prof of (profs ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>) {
      if (!prof.email || !prof.email.includes("@")) continue;
      const allowed = projectsByAdmin.get(prof.id) ?? new Set<string>();
      if (allowed.size === 0) continue;
      const scoped = proposals.filter((p) => {
        const pid = (p.payload as { project_id?: string } | null)?.project_id;
        return typeof pid === "string" && allowed.has(pid);
      });
      await sendTo(prof.email, prof.full_name, scoped, "scoped");
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
