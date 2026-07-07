// Planner approval: bulk-queue pending_actions for every step of an approved
// plan in one transaction-ish batch. The user reviewed the whole plan once
// and clicked Approve; each step becomes an individual pending_actions row
// (kind matches the step tool). Approving here does NOT auto-execute the
// downstream side effects — the existing decidePendingAction handler owns
// per-row execution, so each queued row is still visible in /agent/approvals
// and can be individually reviewed if needed.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const StepSchema = z.object({
  title: z.string().min(1).max(200),
  tool: z.enum(["create_alert", "nudge_assignee", "notify"]),
  rationale: z.string().max(1000),
  payload: z
    .object({
      activity: z.string().nullable().optional(),
      person: z.string().nullable().optional(),
      severity: z.enum(["info", "warning", "critical"]).nullable().optional(),
      message: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
    })
    .passthrough(),
});

export const approvePlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (raw: {
      goal: string;
      runId?: string | null;
      steps: Array<z.infer<typeof StepSchema>>;
    }) => ({
      goal: z.string().min(1).max(2000).parse(raw.goal),
      runId: raw.runId ? z.string().uuid().parse(raw.runId) : null,
      steps: z.array(StepSchema).min(1).max(50).parse(raw.steps),
    }),
  )
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;

    const rows = data.steps.map((s) => ({
      kind: s.tool,
      title: s.title.slice(0, 200),
      summary:
        s.tool === "create_alert"
          ? `Alert: ${s.payload.activity ?? "(activity)"} — ${s.payload.severity ?? "warning"}`
          : s.tool === "nudge_assignee"
          ? `Nudge ${s.payload.person ?? "(person)"}${s.payload.activity ? ` about "${s.payload.activity}"` : ""}`
          : s.title,
      rationale: s.rationale.slice(0, 1000),
      payload: { ...s.payload, planned_from_goal: data.goal } as never,
      proposed_by: userId,
      run_id: data.runId,
      status: "pending" as const,
    }));

    const { data: inserted, error } = await supabase
      .from("pending_actions")
      .insert(rows)
      .select("id");
    if (error) throw new Error(error.message);

    // Analytics: one summary event, not per-step spam.
    await supabase.from("agent_run_events").insert({
      actor_id: userId,
      agent: "planner",
      event: "plan_approved",
      run_id: data.runId,
      metadata: { step_count: rows.length, goal: data.goal.slice(0, 200) },
    });

    return {
      ok: true,
      queued: inserted?.length ?? rows.length,
      review_url: "/agent/approvals",
    };
  });

export const rejectPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { runId?: string | null; reason?: string }) => ({
    runId: raw.runId ? z.string().uuid().parse(raw.runId) : null,
    reason: raw.reason?.slice(0, 500) ?? null,
  }))
  .handler(async ({ data, context }) => {
    await context.supabase.from("agent_run_events").insert({
      actor_id: context.userId,
      agent: "planner",
      event: "plan_rejected",
      run_id: data.runId,
      metadata: { reason: data.reason },
    });
    return { ok: true };
  });
