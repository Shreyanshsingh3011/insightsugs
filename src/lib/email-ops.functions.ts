import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type EmailLogRow = {
  id: string;
  message_id: string | null;
  template_name: string | null;
  recipient_email: string | null;
  status: string;
  error_message: string | null;
  created_at: string;
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

export const getEmailQueueStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EmailQueueStatus> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
    if (!isAdmin) {
      return {
        isAdmin: false,
        recent: [],
        totals: {},
        drafts: {
          pending: 0, snoozed: 0, sent: 0, dismissed: 0, queued_email: 0, pending_setup: 0,
        },
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Latest status per message_id via a window sort in JS (dataset is small).
    const { data: rows } = await supabaseAdmin
      .from("email_send_log")
      .select("id,message_id,template_name,recipient_email,status,error_message,created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    const seen = new Set<string>();
    const dedup: EmailLogRow[] = [];
    for (const r of (rows ?? []) as EmailLogRow[]) {
      const key = r.message_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(r);
      if (dedup.length >= 25) break;
    }

    const totals: Record<string, number> = {};
    for (const r of dedup) totals[r.status] = (totals[r.status] ?? 0) + 1;

    // Draft queue snapshot.
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
