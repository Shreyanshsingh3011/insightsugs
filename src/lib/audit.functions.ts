import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * logAudit — write a row to public.audit_log as the authenticated user.
 *
 * Any server function that mutates important state should call this. The RLS
 * policy `audit_log_insert_self` requires actor_id = auth.uid(), which is
 * already enforced by using context.supabase (the user-scoped client).
 *
 * Callable from the client too, but the main call sites are inside other
 * server functions after they finish their primary mutation.
 */
export const logAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      event_type: string;
      project_id?: string | null;
      activity_id?: string | null;
      details?: Record<string, unknown>;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const evt = (data.event_type || "").trim().slice(0, 120);
    if (!evt) return { ok: false as const };
    const { error } = await supabase.from("audit_log").insert({
      actor_id: userId,
      project_id: data.project_id ?? null,
      activity_id: data.activity_id ?? null,
      event_type: evt,
      details: (data.details ?? {}) as Record<string, unknown>,
    });
    if (error) {
      // Non-fatal — audit failures should never break the primary action.
      // eslint-disable-next-line no-console
      console.warn("[logAudit] insert failed", error.message);
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });

/**
 * Server-side helper (not an RPC) — call this from inside other .handler()
 * bodies to record an audit row using the already-authenticated supabase
 * client. Keeps `logAudit` reusable both from the UI and from other server fns.
 */
export async function writeAuditRow(
  supabase: any,
  userId: string,
  row: {
    event_type: string;
    project_id?: string | null;
    activity_id?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from("audit_log").insert({
      actor_id: userId,
      project_id: row.project_id ?? null,
      activity_id: row.activity_id ?? null,
      event_type: row.event_type.slice(0, 120),
      details: row.details ?? {},
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[writeAuditRow] failed", (err as Error).message);
  }
}
