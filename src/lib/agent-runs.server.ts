// Server-only agent run logger. Uses admin client (bypass RLS) — this is
// system audit/telemetry, not user-authored data.
import type { SupabaseClient } from "@supabase/supabase-js";

type ToolCall = {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  ms?: number;
};

export async function startAgentRun(opts: {
  agent: string;
  trigger?: string;
  actorId?: string | null;
  input: unknown;
}): Promise<{ id: string; toolCalls: ToolCall[]; startedAt: number } | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("agent_runs")
      .insert({
        agent: opts.agent,
        trigger: opts.trigger ?? "manual",
        actor_id: opts.actorId ?? null,
        input: opts.input as never,
        status: "running",
      })
      .select("id")
      .single();
    if (error || !data) return null;
    return { id: data.id, toolCalls: [], startedAt: Date.now() };
  } catch {
    return null;
  }
}

export async function finishAgentRun(
  run: { id: string; toolCalls: ToolCall[]; startedAt: number } | null,
  opts: {
    supabase?: SupabaseClient;
    status: "succeeded" | "failed";
    output?: unknown;
    error?: string;
    tokensIn?: number;
    tokensOut?: number;
  },
) {
  if (!run) return;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("agent_runs")
      .update({
        status: opts.status,
        output: (opts.output ?? null) as never,
        error: opts.error ?? null,
        tokens_in: opts.tokensIn ?? null,
        tokens_out: opts.tokensOut ?? null,
        latency_ms: Date.now() - run.startedAt,
        tool_calls: run.toolCalls as never,
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
  } catch {
    /* best-effort */
  }
}

export function recordToolCall(
  run: { toolCalls: ToolCall[] } | null,
  call: ToolCall,
) {
  if (!run) return;
  run.toolCalls.push(call);
}
