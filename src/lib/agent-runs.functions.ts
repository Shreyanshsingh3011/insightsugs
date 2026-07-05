// Server functions for agent runs observability + feedback.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AgentRunRow = {
  id: string;
  agent: string;
  trigger: string;
  status: string;
  actor_id: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  tool_calls: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  feedback: number | null;
  feedback_note: string | null;
  cost_credits: number | null;
  created_at: string;
  finished_at: string | null;
};

export const listAgentRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (raw: { agent?: string; limit?: number; scope?: "mine" | "all" } = {}) => ({
      agent: raw.agent?.slice(0, 64) ?? null,
      limit: Math.min(Math.max(raw.limit ?? 50, 1), 200),
      scope: raw.scope === "all" ? "all" : "mine",
    }),
  )
  .handler(async ({ data, context }): Promise<AgentRunRow[]> => {
    let q = context.supabase
      .from("agent_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.agent) q = q.eq("agent", data.agent);
    if (data.scope === "mine") q = q.eq("actor_id", context.userId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []) as unknown as AgentRunRow[];
  });

export const submitAgentRunFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (raw: { runId: string; rating: 1 | -1; note?: string }) => ({
      runId: z.string().uuid().parse(raw.runId),
      rating: z.union([z.literal(1), z.literal(-1)]).parse(raw.rating),
      note: raw.note?.slice(0, 500) ?? null,
    }),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("agent_runs")
      .update({ feedback: data.rating, feedback_note: data.note })
      .eq("id", data.runId);
    if (error) throw new Error(error.message);
    await context.supabase.from("agent_run_events").insert({
      actor_id: context.userId,
      agent: "feedback",
      event: data.rating > 0 ? "thumbs_up" : "thumbs_down",
      run_id: data.runId,
      metadata: { note: data.note },
    });
    return { ok: true };
  });

export type AgentStats = {
  total_runs: number;
  succeeded: number;
  failed: number;
  avg_latency_ms: number | null;
  total_tokens: number;
  thumbs_up: number;
  thumbs_down: number;
  pending_actions: number;
};

export const getAgentStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AgentStats> => {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: runs } = await context.supabase
      .from("agent_runs")
      .select("status, latency_ms, tokens_in, tokens_out, feedback")
      .gte("created_at", since);
    const rows = runs ?? [];
    const succeeded = rows.filter((r) => r.status === "succeeded").length;
    const failed = rows.filter((r) => r.status === "failed").length;
    const latencies = rows
      .map((r) => r.latency_ms)
      .filter((n): n is number => typeof n === "number");
    const avg =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : null;
    const tokens = rows.reduce(
      (acc, r) => acc + (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
      0,
    );
    const up = rows.filter((r) => (r.feedback ?? 0) > 0).length;
    const down = rows.filter((r) => (r.feedback ?? 0) < 0).length;
    const { count } = await context.supabase
      .from("pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    return {
      total_runs: rows.length,
      succeeded,
      failed,
      avg_latency_ms: avg,
      total_tokens: tokens,
      thumbs_up: up,
      thumbs_down: down,
      pending_actions: count ?? 0,
    };
  });
