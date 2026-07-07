// Server functions for the Audit Log page. Reads audit_log rows created
// whenever an admin approves or rejects a pending_action or signup_request.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

export type AuditEntry = {
  id: string;
  actor_id: string | null;
  event_type: string;
  details: Json;
  created_at: string;
  actor_name?: string | null;
  actor_email?: string | null;
};

const FilterEnum = z.enum(["all", "action", "signup", "approve", "reject"]);

export const listAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { filter?: string; limit?: number } = {}) => ({
    filter: FilterEnum.parse(raw.filter ?? "all"),
    limit: Math.min(Math.max(raw.limit ?? 100, 1), 500),
  }))
  .handler(async ({ data, context }): Promise<AuditEntry[]> => {
    const { supabase } = context;
    let q = supabase
      .from("audit_log")
      .select("id, actor_id, event_type, details, created_at")
      .like("event_type", "approval.%")
      .order("created_at", { ascending: false })
      .limit(data.limit);

    if (data.filter === "action") q = q.like("event_type", "approval.action.%");
    else if (data.filter === "signup") q = q.like("event_type", "approval.signup.%");
    else if (data.filter === "approve") q = q.like("event_type", "approval.%.approve");
    else if (data.filter === "reject") q = q.like("event_type", "approval.%.reject");

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    const list = (rows ?? []) as AuditEntry[];

    const actorIds = Array.from(new Set(list.map(r => r.actor_id).filter((x): x is string => !!x)));
    if (actorIds.length) {
      const { data: profs } = await supabase
        .from("profiles").select("id, full_name, email").in("id", actorIds);
      const byId = new Map((profs ?? []).map(p => [p.id, p]));
      list.forEach(r => {
        if (r.actor_id) {
          const p = byId.get(r.actor_id);
          r.actor_name = p?.full_name ?? null;
          r.actor_email = p?.email ?? null;
        }
      });
    }
    return list;
  });
