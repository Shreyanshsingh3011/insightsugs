// Server functions for the Approval Inbox.
// pending_actions rows are proposals from agents (write tools). A user must
// approve or reject before the action executes. This module owns list/decide.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type PendingAction = {
  id: string;
  kind: string;
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  title: string | null;
  summary: string;
  rationale: string | null;
  payload: Json;
  proposed_by: string | null;
  assigned_to: string | null;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  execution_error: string | null;
  run_id: string | null;
  created_at: string;
};

const StatusEnum = z.enum(["pending", "approved", "rejected", "executed", "failed", "all"]);

export const listPendingActions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { status?: string; limit?: number } = {}) => ({
    status: StatusEnum.parse(raw.status ?? "pending"),
    limit: Math.min(Math.max(raw.limit ?? 50, 1), 200),
  }))
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("pending_actions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as PendingAction[];
  });

export const decidePendingAction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (raw: { id: string; decision: "approve" | "reject"; note?: string }) => ({
      id: z.string().uuid().parse(raw.id),
      decision: z.enum(["approve", "reject"]).parse(raw.decision),
      note: raw.note?.slice(0, 500) ?? null,
    }),
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;

    // Snapshot BEFORE state for audit log
    const { data: before } = await supabase
      .from("pending_actions")
      .select("*")
      .eq("id", data.id)
      .single();

    const status = data.decision === "approve" ? "approved" : "rejected";
    const { data: updated, error } = await supabase
      .from("pending_actions")
      .update({
        status,
        decided_by: userId,
        decided_at: new Date().toISOString(),
        execution_error: data.note,
      })
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    let execError: string | null = null;
    let after = updated;
    if (data.decision === "approve") {
      try {
        const { data: exec } = await supabase
          .from("pending_actions")
          .update({ status: "executed", executed_at: new Date().toISOString() })
          .eq("id", data.id)
          .select("*")
          .single();
        if (exec) after = exec;
      } catch (e) {
        execError = e instanceof Error ? e.message : String(e);
        await supabase
          .from("pending_actions")
          .update({ status: "failed", execution_error: execError })
          .eq("id", data.id);
      }
    }

    await supabase.from("agent_run_events").insert({
      actor_id: userId,
      agent: "approval",
      event: data.decision === "approve" ? "action_approved" : "action_rejected",
      action_id: data.id,
      run_id: updated?.run_id ?? null,
      metadata: { kind: updated?.kind, exec_error: execError },
    });

    // Audit log — who decided what, with before/after summary
    await supabase.from("audit_log").insert({
      actor_id: userId,
      event_type: data.decision === "approve" ? "approval.action.approve" : "approval.action.reject",
      details: {
        target: "pending_action",
        target_id: data.id,
        kind: updated?.kind,
        title: updated?.title ?? updated?.summary,
        note: data.note,
        exec_error: execError,
        before: before
          ? { status: before.status, decided_by: before.decided_by, decided_at: before.decided_at }
          : null,
        after: after
          ? { status: after.status, decided_by: after.decided_by, decided_at: after.decided_at, executed_at: after.executed_at }
          : null,
      },
    });

    return { ok: true, executed: data.decision === "approve" && !execError };
  });

export const countPendingActions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count, error } = await context.supabase
      .from("pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { count: count ?? 0 };
  });
