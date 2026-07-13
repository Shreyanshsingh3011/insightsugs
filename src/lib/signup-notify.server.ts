// Shared helper: notify all super admins of a pending signup request for the
// currently authenticated user. Deduped via signup_notifications.
//
// Server-only: takes an already-authenticated Supabase client (RLS as the user)
// and the user id, so it can be called from any server function without
// crossing the createServerFn RPC boundary.

import type { SupabaseClient } from "@supabase/supabase-js";

export async function notifySuperAdminsOfPendingSignupImpl(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ ok: true; emailed: number }> {
  const { data: req } = await supabase
    .from("signup_requests")
    .select("id, email, full_name, requested_role, status")
    .eq("user_id", userId)
    .eq("status", "pending")
    .maybeSingle();
  if (!req) return { ok: true, emailed: 0 };

  const { data: prior } = await supabase
    .from("signup_notifications")
    .select("id")
    .eq("request_id", req.id)
    .eq("channel", "email")
    .limit(1);
  if (prior && prior.length > 0) return { ok: true, emailed: 0 };

  const { data: recipients } = await supabase.rpc("list_super_admin_emails");
  const list = (recipients ?? []) as { user_id: string; email: string; full_name: string | null }[];
  if (list.length === 0) return { ok: true, emailed: 0 };

  const { enqueueAppEmail } = await import("@/lib/email/enqueue-app-email.server");

  let sent = 0;
  for (const admin of list) {
    const r = await enqueueAppEmail({
      templateName: "signup-pending-review",
      recipientEmail: admin.email,
      idempotencyKey: `signup-pending-${req.id}-${admin.user_id}`,
      templateData: {
        reviewerName: admin.full_name ?? "",
        candidateName: req.full_name ?? "",
        candidateEmail: req.email,
        requestedRole: req.requested_role,
        reviewUrl: "https://insightsugs.lovable.app/agent/approvals",
      },
    });
    if (r.ok) sent += 1;
  }

  await supabase.from("signup_notifications").insert({
    request_id: req.id,
    sent_by: userId,
    channel: "email",
    note: `Emailed ${sent} super admin(s)`,
  });

  return { ok: true, emailed: sent };
}

export const OFFICIAL_DOMAIN = "sugslloyds.com";

export function isOfficialEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith("@" + OFFICIAL_DOMAIN);
}
