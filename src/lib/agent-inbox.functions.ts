import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeAuditRow } from "./audit.functions";
import { escapeIlike, normalizeEmail } from "@/lib/sql-escape";

// ---------- Types ----------

export type AgentDraft = {
  id: string;
  draft_type: string;
  source_kind: string;
  source_key: string;
  title: string;
  subject: string | null;
  body: string;
  channel: string; // 'email' | 'direct_message' | 'slack' | 'sheet_writeback'
  recipient_email: string | null;
  recipient_user_id: string | null;
  // JSON-serializable, kept opaque at the RPC boundary
  cc: any;
  confidence: number;
  why: string | null;
  payload: any;
  state:
    | "pending"
    | "approved"
    | "dismissed"
    | "snoozed"
    | "sent"
    | "failed";
  dismiss_reason: string | null;
  snoozed_until: string | null;
  assigned_to: string | null;
  created_by_rule: string | null;
  playbook_slug: string | null;
  playbook_step: number | null;
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  send_result: any;
  created_at: string;
  updated_at: string;
  // enriched:
  assignee?: { full_name: string; email: string } | null;
  recipient?: { full_name: string; email: string } | null;
};

// ---------- Helpers ----------

async function isAdmin(supabase: any, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roles = (data ?? []).map((r: any) => r.role);
  return roles.includes("admin") || roles.includes("super_admin");
}

async function attachProfiles(supabase: any, rows: AgentDraft[]): Promise<AgentDraft[]> {
  const ids = new Set<string>();
  rows.forEach((r) => {
    if (r.assigned_to) ids.add(r.assigned_to);
    if (r.recipient_user_id) ids.add(r.recipient_user_id);
  });
  if (ids.size === 0) return rows;
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in("id", Array.from(ids));
  const map = new Map<string, { full_name: string; email: string }>(
    (data ?? []).map((p: any) => [p.id, { full_name: p.full_name ?? "", email: p.email ?? "" }]),
  );
  return rows.map((r) => ({
    ...r,
    assignee: r.assigned_to ? map.get(r.assigned_to) ?? null : null,
    recipient: r.recipient_user_id ? map.get(r.recipient_user_id) ?? null : null,
  }));
}

// ---------- LIST ----------

const ListInput = z.object({
  states: z
    .array(z.enum(["pending", "approved", "dismissed", "snoozed", "sent", "failed"]))
    .optional(),
  scope: z.enum(["mine", "all"]).default("mine"),
  limit: z.number().int().min(1).max(500).default(200),
});

export const listAgentDrafts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const admin = await isAdmin(supabase, userId);

    let q = supabase
      .from("agent_drafts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.states && data.states.length > 0) {
      q = q.in("state", data.states);
    }
    // Non-admins only ever see their own (RLS enforces too, but this keeps
    // "all" from returning admin-scoped rows for regular users).
    if (!admin || data.scope === "mine") {
      q = q.eq("assigned_to", userId);
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const enriched = await attachProfiles(supabase, (rows ?? []) as AgentDraft[]);
    return { drafts: enriched, isAdmin: admin };
  });

// ---------- CREATE (from user, e.g. "Draft from answer") ----------

const CreateInput = z.object({
  draft_type: z.string().min(1).max(60),
  source_kind: z.string().min(1).max(40),
  source_key: z.string().min(1).max(400),
  title: z.string().min(1).max(400),
  subject: z.string().max(400).optional().nullable(),
  body: z.string().min(1).max(20000),
  channel: z
    .enum(["email", "direct_message", "slack", "sheet_writeback"])
    .default("direct_message"),
  recipient_email: z.string().email().max(255).optional().nullable(),
  recipient_user_id: z.string().uuid().optional().nullable(),
  cc: z
    .array(z.object({ email: z.string().email(), name: z.string().optional().nullable() }))
    .max(50)
    .optional(),
  confidence: z.number().min(0).max(1).default(0.6),
  why: z.string().max(2000).optional().nullable(),
  payload: z.record(z.string(), z.unknown()).optional(),
  assigned_to: z.string().uuid().optional().nullable(),
});

export const createAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CreateInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    // Inserts happen through service_role because the RLS surface intentionally
    // has no INSERT policy for authenticated (drafts must originate on the
    // server so the queue stays deterministic).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Resolve assignee: explicit → recipient user → the caller (as fallback).
    let assigned = data.assigned_to ?? data.recipient_user_id ?? null;

    // If recipient_email was supplied but no user_id, try to resolve it.
    let recipient_user_id = data.recipient_user_id ?? null;
    if (!recipient_user_id && data.recipient_email) {
      const { data: prof } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .ilike("email", escapeIlike(normalizeEmail(data.recipient_email)))
        .maybeSingle();
      if (prof?.id) recipient_user_id = prof.id;
    }
    if (!assigned) assigned = recipient_user_id ?? userId;

    const insertRow: any = {
      draft_type: data.draft_type,
      source_kind: data.source_kind,
      source_key: data.source_key,
      title: data.title.slice(0, 400),
      subject: data.subject?.slice(0, 400) ?? null,
      body: data.body,
      channel: data.channel,
      recipient_email: data.recipient_email ?? null,
      recipient_user_id,
      cc: data.cc ?? [],
      confidence: data.confidence,
      why: data.why ?? null,
      payload: data.payload ?? {},
      assigned_to: assigned,
      created_by_rule: "user:draft_from_answer",
    };
    const { data: inserted, error } = await supabaseAdmin
      .from("agent_drafts")
      .insert(insertRow)
      .select("id")
      .single();

    if (error) {
      // Unique dedupe hit is fine — return the existing pending one.
      if ((error as any).code === "23505") {
        const { data: existing } = await supabaseAdmin
          .from("agent_drafts")
          .select("id")
          .eq("draft_type", data.draft_type)
          .eq("source_kind", data.source_kind)
          .eq("source_key", data.source_key)
          .in("state", ["pending", "snoozed"])
          .limit(1)
          .maybeSingle();
        return { id: existing?.id ?? null, deduped: true };
      }
      throw new Error(error.message);
    }

    await writeAuditRow(supabase, userId, {
      event_type: "agent_draft.created",
      details: {
        draft_id: inserted?.id,
        draft_type: data.draft_type,
        source_kind: data.source_kind,
        source_key: data.source_key,
      },
    });

    return { id: inserted!.id as string, deduped: false };
  });

// ---------- UPDATE (edit body/subject before approving) ----------

const EditInput = z.object({
  id: z.string().uuid(),
  subject: z.string().max(400).optional().nullable(),
  body: z.string().min(1).max(20000).optional(),
  recipient_email: z.string().email().max(255).optional().nullable(),
});

export const editAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => EditInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const patch: Record<string, unknown> = {};
    if (data.subject !== undefined) patch.subject = data.subject;
    if (data.body !== undefined) patch.body = data.body;
    if (data.recipient_email !== undefined) patch.recipient_email = data.recipient_email;
    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await supabase
      .from("agent_drafts")
      .update(patch)
      .eq("id", data.id)
      .in("state", ["pending", "snoozed"]);
    if (error) throw new Error(error.message);

    await writeAuditRow(supabase, userId, {
      event_type: "agent_draft.edited",
      details: { draft_id: data.id, fields: Object.keys(patch) },
    });
    return { ok: true };
  });

// ---------- SNOOZE ----------

const SnoozeInput = z.object({
  id: z.string().uuid(),
  hours: z.number().int().min(1).max(24 * 14).default(24),
});

export const snoozeAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SnoozeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const until = new Date(Date.now() + data.hours * 3600 * 1000).toISOString();
    const { error } = await supabase
      .from("agent_drafts")
      .update({ state: "snoozed", snoozed_until: until })
      .eq("id", data.id)
      .in("state", ["pending", "snoozed"]);
    if (error) throw new Error(error.message);
    await writeAuditRow(supabase, userId, {
      event_type: "agent_draft.snoozed",
      details: { draft_id: data.id, snoozed_until: until, hours: data.hours },
    });
    return { ok: true, snoozed_until: until };
  });

// ---------- DISMISS ----------

const DismissInput = z.object({
  id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
});

export const dismissAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => DismissInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase
      .from("agent_drafts")
      .update({ state: "dismissed", dismiss_reason: data.reason ?? null })
      .eq("id", data.id)
      .in("state", ["pending", "snoozed"]);
    if (error) throw new Error(error.message);
    await writeAuditRow(supabase, userId, {
      event_type: "agent_draft.dismissed",
      details: { draft_id: data.id, reason: data.reason ?? null },
    });
    return { ok: true };
  });

// ---------- APPROVE & SEND ----------

const ApproveInput = z.object({
  id: z.string().uuid(),
});

export const approveAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ApproveInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };

    // 1. Load the draft with RLS (reviewer or admin only can see it).
    const { data: draft, error: readErr } = await supabase
      .from("agent_drafts")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!draft) throw new Error("Draft not found or not accessible.");
    if (draft.state !== "pending" && draft.state !== "snoozed") {
      throw new Error(`Draft is already ${draft.state}.`);
    }

    // 2. Dispatch by channel.
    const send_result: Record<string, unknown> = {
      dispatched_at: new Date().toISOString(),
      channel: draft.channel,
    };
    let delivery: "in_app" | "email_pending" | "noop" = "noop";

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (draft.recipient_user_id) {
      // In-app: create a direct_messages row from the approver to the recipient.
      const { data: inserted, error: dmErr } = await supabaseAdmin
        .from("direct_messages")
        .insert({
          sender_id: userId,
          recipient_id: draft.recipient_user_id,
          subject: (draft.subject ?? draft.title).slice(0, 400),
          body: draft.body,
          context_kind: `agent_draft:${draft.draft_type}`,
          context_ref: `${draft.source_kind}:${draft.source_key}`,
        })
        .select("id")
        .single();
      if (dmErr) throw new Error(dmErr.message);
      send_result.direct_message_id = inserted?.id;
      delivery = "in_app";

      // Best-effort notification (matches sendDirectMessage pattern).
      try {
        const { data: sender } = await supabaseAdmin
          .from("profiles")
          .select("full_name, email")
          .eq("id", userId)
          .maybeSingle();
        const from = sender?.full_name || sender?.email || "Agent";
        await supabaseAdmin.from("notifications").insert({
          user_id: draft.recipient_user_id,
          kind: "agent_action",
          title: `${from}: ${draft.title}`.slice(0, 200),
          body: (draft.subject ?? draft.body).slice(0, 500),
        });
      } catch {
        /* non-fatal */
      }
    } else if (draft.recipient_email) {
      // Email-only recipient (unknown user). Actually send the email via the
      // transactional queue (rendered from the agent-notification template).
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
        idempotencyKey: `agent-draft-${draft.id}`,
        templateData: {
          recipientName: undefined,
          senderName: "InsightSugs Agent",
          subject: draft.subject ?? draft.title,
          message: draft.body,
          context: ctxParts.join(" · ") || undefined,
          reasonWhy: draft.why ?? undefined,
        },
      });
      send_result.email = draft.recipient_email;
      if (r.ok) {
        send_result.status = "email_queued";
        send_result.message_id = r.messageId;
      } else {
        send_result.status = `email_${r.reason}`;
        if (r.error) send_result.email_error = r.error;
      }
      delivery = "email_pending";
    }

    // 3. Mark the draft as sent.
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("agent_drafts")
      .update({
        state: "sent",
        approved_by: userId,
        approved_at: nowIso,
        sent_at: nowIso,
        send_result: send_result as any,
      } as any)
      .eq("id", draft.id);
    if (updErr) throw new Error(updErr.message);

    // 4. Audit trail
    await writeAuditRow(supabase, userId, {
      event_type: "agent_draft.approved",
      details: {
        draft_id: draft.id,
        draft_type: draft.draft_type,
        source_kind: draft.source_kind,
        source_key: draft.source_key,
        delivery,
        recipient_user_id: draft.recipient_user_id,
        recipient_email: draft.recipient_email,
      },
    });

    return { ok: true as const, delivery, send_result: send_result as any };
  });

// ---------- UNSNOOZE (admin / reviewer can restore a snoozed draft) ----------

export const unsnoozeAgentDraft = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: z.string().uuid().parse(d.id) }))
  .handler(async ({ data, context }) => {
    const { supabase } = context as { supabase: any };
    const { error } = await supabase
      .from("agent_drafts")
      .update({ state: "pending", snoozed_until: null })
      .eq("id", data.id)
      .eq("state", "snoozed");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
