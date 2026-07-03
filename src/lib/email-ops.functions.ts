import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EmailLogRow = {
  id: string;
  message_id: string | null;
  template_name: string | null;
  recipient_email: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
  draft_id: string | null;
};

export type EmailQueueStatus = {
  isAdmin: boolean;
  recent: EmailLogRow[];
  totals: Record<string, number>;
  drafts: {
    pending: number;
    snoozed: number;
    sent: number;
    dismissed: number;
    queued_email: number;
    pending_setup: number;
  };
};

async function assertAdmin(context: any) {
  const { supabase, userId } = context as { supabase: any; userId: string };
  const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
  return { isAdmin: !!isAdmin, userId };
}

/** Extract draft_id from an idempotency-key style message_id like `agent-draft-<uuid>-retry-<ts>`. */
function draftIdFromMessageId(mid: string | null): string | null {
  if (!mid) return null;
  const m = mid.match(/^agent-draft-([0-9a-f-]{36})(?:-|$)/i);
  return m ? m[1] : null;
}

export const getEmailQueueStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EmailQueueStatus> => {
    const { isAdmin } = await assertAdmin(context);
    if (!isAdmin) {
      return {
        isAdmin: false,
        recent: [],
        totals: {},
        drafts: { pending: 0, snoozed: 0, sent: 0, dismissed: 0, queued_email: 0, pending_setup: 0 },
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: rows } = await supabaseAdmin
      .from("email_send_log")
      .select("id,message_id,template_name,recipient_email,status,error_message,created_at")
      .order("created_at", { ascending: false })
      .limit(2000);

    // Deduplicate to latest per message_id.
    const seen = new Set<string>();
    const dedup: EmailLogRow[] = [];
    for (const r of (rows ?? []) as any[]) {
      const key = r.message_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push({ ...r, draft_id: draftIdFromMessageId(r.message_id) });
      if (dedup.length >= 300) break;
    }

    // Enrich remaining agent-notification rows via agent_drafts.send_result.message_id.
    const needLookup = dedup
      .filter((r) => !r.draft_id && r.template_name === "agent-notification" && r.message_id)
      .map((r) => r.message_id as string);
    if (needLookup.length > 0) {
      const { data: drafts } = await supabaseAdmin
        .from("agent_drafts")
        .select("id,send_result");
      const byMsg = new Map<string, string>();
      for (const d of (drafts ?? []) as any[]) {
        const mid = d?.send_result?.message_id;
        if (typeof mid === "string") byMsg.set(mid, d.id);
      }
      for (const r of dedup) {
        if (!r.draft_id && r.message_id && byMsg.has(r.message_id)) r.draft_id = byMsg.get(r.message_id)!;
      }
    }

    const totals: Record<string, number> = {};
    for (const r of dedup) totals[r.status] = (totals[r.status] ?? 0) + 1;

    const { data: draftRows } = await supabaseAdmin
      .from("agent_drafts")
      .select("state,send_result");
    const drafts = {
      pending: 0, snoozed: 0, sent: 0, dismissed: 0, queued_email: 0, pending_setup: 0,
    };
    for (const d of (draftRows ?? []) as any[]) {
      if (d.state === "pending") drafts.pending++;
      else if (d.state === "snoozed") drafts.snoozed++;
      else if (d.state === "sent") drafts.sent++;
      else if (d.state === "dismissed") drafts.dismissed++;
      const st = d.send_result?.status;
      if (st === "email_queued") drafts.queued_email++;
      else if (st === "email_pending_setup") drafts.pending_setup++;
    }

    return { isAdmin: true, recent: dedup, totals, drafts };
  });

/** Per-draft resend history: all log rows whose message_id references this draft, newest first. */
export const getDraftResendHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ draftId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { isAdmin } = await assertAdmin(context);
    if (!isAdmin) throw new Error("Forbidden");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Match both the original enqueue key `agent-draft-<id>` and retries `agent-draft-<id>-retry-*`.
    const { data: rows } = await supabaseAdmin
      .from("email_send_log")
      .select("id,message_id,template_name,recipient_email,status,error_message,created_at")
      .like("message_id", `agent-draft-${data.draftId}%`)
      .order("created_at", { ascending: false })
      .limit(200);

    // Also include any legacy row referenced by the draft's send_result.message_id.
    const { data: draft } = await supabaseAdmin
      .from("agent_drafts")
      .select("send_result")
      .eq("id", data.draftId)
      .maybeSingle();
    const legacyMid = (draft?.send_result as any)?.message_id as string | undefined;
    let extra: any[] = [];
    if (legacyMid && !((rows ?? []) as any[]).some((r) => r.message_id === legacyMid)) {
      const { data: legacy } = await supabaseAdmin
        .from("email_send_log")
        .select("id,message_id,template_name,recipient_email,status,error_message,created_at")
        .eq("message_id", legacyMid)
        .order("created_at", { ascending: false });
      extra = legacy ?? [];
    }
    return { rows: [...(rows ?? []), ...extra] as EmailLogRow[] };
  });

async function resendOne(draftId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: draft, error } = await supabaseAdmin
    .from("agent_drafts")
    .select("*")
    .eq("id", draftId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!draft) return { ok: false, reason: "not_found" as const };
  if (!draft.recipient_email) return { ok: false, reason: "no_recipient" as const };

  const normalized = draft.recipient_email.toLowerCase();
  await supabaseAdmin.from("suppressed_emails").delete().eq("email", normalized);

  const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");
  const payload = (draft.payload ?? {}) as Record<string, unknown>;
  const ctxParts = [
    payload.project ? `Project ${payload.project}` : "",
    payload.stage ? `Stage ${payload.stage}` : "",
    payload.activity ? `Activity ${payload.activity}` : "",
  ].filter(Boolean);

  const r = await enqueueAppEmail({
    templateName: "agent-notification",
    recipientEmail: draft.recipient_email,
    idempotencyKey: `agent-draft-${draft.id}-retry-${Date.now()}`,
    templateData: {
      senderName: "InsightSugs Agent",
      subject: draft.subject ?? draft.title,
      message: draft.body,
      context: ctxParts.join(" · ") || undefined,
      reasonWhy: draft.why ?? undefined,
    },
  });

  const prev = (draft.send_result && typeof draft.send_result === "object" ? draft.send_result : {}) as Record<string, unknown>;
  const send_result: Record<string, unknown> = {
    ...prev,
    channel: draft.channel,
    email: draft.recipient_email,
    retried_at: new Date().toISOString(),
  };
  if (r.ok) {
    send_result.status = "email_queued";
    send_result.message_id = r.messageId;
  } else {
    send_result.status = `email_${r.reason}`;
    if (r.error) send_result.email_error = r.error;
  }
  await supabaseAdmin.from("agent_drafts").update({ send_result: send_result as any }).eq("id", draft.id);

  return { ok: r.ok, reason: r.ok ? "queued" : r.reason, messageId: r.ok ? r.messageId : null };
}

export const resendAgentDraftEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ draftId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { isAdmin } = await assertAdmin(context);
    if (!isAdmin) throw new Error("Forbidden");
    return resendOne(data.draftId);
  });

export const bulkResendAgentDraftEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ draftIds: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await assertAdmin(context);
    if (!isAdmin) throw new Error("Forbidden");
    const results: { draftId: string; ok: boolean; reason: string; messageId: string | null }[] = [];
    for (const id of data.draftIds) {
      try {
        const r = await resendOne(id);
        results.push({ draftId: id, ok: r.ok, reason: String(r.reason), messageId: r.messageId ?? null });
      } catch (e) {
        results.push({ draftId: id, ok: false, reason: e instanceof Error ? e.message : "error", messageId: null });
      }
    }
    const okCount = results.filter((r) => r.ok).length;
    return { results, okCount, failCount: results.length - okCount };
  });
