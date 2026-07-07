import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Minimal CSV parser (quoted fields, escaped quotes, CRLF).
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(c => c.length)) rows.push(row);
        row = [];
      } else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); if (row.some(c => c.length)) rows.push(row); }
  return rows;
}

function norm(s: string) { return s.trim().toLowerCase(); }

/**
 * Verify the current signed-in user against the signup allowlist sheet.
 * The sheet must be a public CSV URL configured in the SIGNUP_ALLOWLIST_CSV_URL env
 * (e.g. Google Sheets published as CSV). Expected columns (case-insensitive):
 *   Name (or Full Name), Email, Role (optional: 'user' | 'admin' — default 'user')
 * A row matches when both the email AND the full name equal the user's values.
 */
export const verifySignupAgainstSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{
    verified: boolean; reason: string; role?: "user" | "admin";
  }> => {
    const { supabase, userId } = context;

    // Already approved?
    const { data: existing } = await supabase.from("user_roles").select("role").eq("user_id", userId).limit(1);
    if (existing && existing.length) return { verified: true, reason: "already approved" };

    // 1) In-app allowlist first (managed by super admins under /admin/allowlist).
    const { data: rpc, error: rpcErr } = await supabase.rpc("verify_signup_from_allowlist");
    if (!rpcErr && Array.isArray(rpc) && rpc.length > 0) {
      const row = rpc[0] as { verified: boolean; reason: string; granted_role: "user" | "admin" | null };
      if (row.verified) {
        return { verified: true, reason: row.reason, role: row.granted_role ?? undefined };
      }
      // fall through to CSV fallback only when the reason is "not found"
      if (!/Not found in allowlist/i.test(row.reason)) {
        return { verified: false, reason: row.reason };
      }
    }

    // 2) Optional CSV allowlist fallback (legacy).
    const { data: prof } = await supabase.from("profiles").select("full_name, email").eq("id", userId).maybeSingle();
    const email = norm(prof?.email ?? "");
    const name = norm(prof?.full_name ?? "");
    if (!email) return { verified: false, reason: "No email on profile" };

    const url = process.env.SIGNUP_ALLOWLIST_CSV_URL;
    if (!url) return { verified: false, reason: "Not found in allowlist — awaiting super admin approval." };

    let text: string;
    try {
      const r = await fetch(url, { headers: { Accept: "text/csv,*/*" }, redirect: "follow" });
      if (!r.ok) return { verified: false, reason: `Allowlist unreachable (HTTP ${r.status})` };
      text = await r.text();
    } catch (e) {
      return { verified: false, reason: `Allowlist fetch failed: ${e instanceof Error ? e.message : "unknown"}` };
    }

    const rows = parseCSV(text);
    if (rows.length < 2) return { verified: false, reason: "Allowlist is empty" };
    const hdrs = rows[0].map(h => norm(h));
    const idx = (needles: string[]) => hdrs.findIndex(h => needles.some(n => h.includes(n)));
    const iEmail = idx(["email", "mail"]);
    const iName = idx(["name"]);
    const iRole = idx(["role"]);
    if (iEmail < 0) return { verified: false, reason: "Allowlist missing 'email' column" };

    for (const row of rows.slice(1)) {
      const rowEmail = norm(row[iEmail] ?? "");
      if (!rowEmail || rowEmail !== email) continue;
      const rowName = iName >= 0 ? norm(row[iName] ?? "") : "";
      if (iName >= 0 && rowName && name && rowName !== name) {
        return { verified: false, reason: `Email in allowlist but name doesn't match (sheet: ${row[iName]})` };
      }
      const rawRole = iRole >= 0 ? norm(row[iRole] ?? "") : "user";
      const role: "user" | "admin" = rawRole === "admin" ? "admin" : "user";
      const { error: rpcErr2 } = await supabase.rpc("self_verify_signup", { _role: role });
      if (rpcErr2) return { verified: false, reason: rpcErr2.message };
      return { verified: true, reason: "Matched in allowlist sheet", role };
    }
    return { verified: false, reason: "Not found in allowlist — awaiting super admin approval." };
  });

// Fan out email + record notifications to all super admins for a pending signup.
// Idempotent-ish: uses signup_notifications to dedupe repeated attempts.
export const notifySuperAdminsOfPendingSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ok: true; emailed: number } | { ok: false; reason: string }> => {
    const { supabase, userId } = context;

    const { data: req } = await supabase
      .from("signup_requests")
      .select("id, email, full_name, requested_role, status")
      .eq("user_id", userId)
      .eq("status", "pending")
      .maybeSingle();
    if (!req) return { ok: true, emailed: 0 };

    // Dedupe: skip if we've already emailed super admins for this request.
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
  });


export type PendingRequest = {
  id: string; user_id: string; email: string; full_name: string | null;
  requested_role: "super_admin" | "admin" | "user";
  status: "pending" | "approved" | "rejected";
  verified_via: string | null; granted_role: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null; created_at: string;
  reject_reason: string | null;
  last_notified_at: string | null;
  notify_count: number | null;
  reviewer_name?: string | null;
  reviewer_email?: string | null;
};

export const listSignupRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PendingRequest[]> => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("signup_requests")
      .select("id, user_id, email, full_name, requested_role, status, verified_via, granted_role, reviewed_by, reviewed_at, created_at, reject_reason, last_notified_at, notify_count")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as PendingRequest[];
    const reviewerIds = Array.from(new Set(rows.map(r => r.reviewed_by).filter((x): x is string => !!x)));
    if (reviewerIds.length) {
      const { data: profs } = await supabase
        .from("profiles").select("id, full_name, email").in("id", reviewerIds);
      const byId = new Map((profs ?? []).map(p => [p.id, p]));
      rows.forEach(r => {
        if (r.reviewed_by) {
          const p = byId.get(r.reviewed_by);
          r.reviewer_name = p?.full_name ?? null;
          r.reviewer_email = p?.email ?? null;
        }
      });
    }
    return rows;
  });

export const approveSignupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { requestId: string; role: "super_admin" | "admin" | "user" }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: before } = await supabase
      .from("signup_requests")
      .select("id, email, full_name, requested_role, status, granted_role")
      .eq("id", data.requestId)
      .maybeSingle();
    const { error } = await supabase.rpc("approve_signup", {
      _request_id: data.requestId,
      _role: data.role,
    });
    if (error) throw new Error(error.message);
    await supabase.from("audit_log").insert({
      actor_id: userId,
      event_type: "approval.signup.approve",
      details: {
        target: "signup_request",
        target_id: data.requestId,
        subject_email: before?.email,
        subject_name: before?.full_name,
        before: before
          ? { status: before.status, granted_role: before.granted_role, requested_role: before.requested_role }
          : null,
        after: { status: "approved", granted_role: data.role, verified_via: "admin" },
      },
    });
    return { ok: true };
  });

export const rejectSignupFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { requestId: string; reason?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: before } = await supabase
      .from("signup_requests")
      .select("id, email, full_name, requested_role, status, granted_role")
      .eq("id", data.requestId)
      .maybeSingle();
    const { error } = await supabase.rpc("reject_signup", {
      _request_id: data.requestId,
      _reason: data.reason ?? "",
    });
    if (error) throw new Error(error.message);
    await supabase.from("audit_log").insert({
      actor_id: userId,
      event_type: "approval.signup.reject",
      details: {
        target: "signup_request",
        target_id: data.requestId,
        subject_email: before?.email,
        subject_name: before?.full_name,
        reason: data.reason ?? null,
        before: before
          ? { status: before.status, granted_role: before.granted_role, requested_role: before.requested_role }
          : null,
        after: { status: "rejected", reject_reason: data.reason ?? null },
      },
    });
    return { ok: true };
  });

export const resendVerificationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { requestId: string; note?: string }) => d)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("resend_signup_verification", {
      _request_id: data.requestId,
      _note: data.note ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const mySignupStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PendingRequest | null> => {
    const { data } = await context.supabase
      .from("signup_requests")
      .select("id, user_id, email, full_name, requested_role, status, verified_via, granted_role, reviewed_by, reviewed_at, created_at, reject_reason, last_notified_at, notify_count")
      .eq("user_id", context.userId)
      .maybeSingle();
    return (data as PendingRequest) ?? null;
  });
