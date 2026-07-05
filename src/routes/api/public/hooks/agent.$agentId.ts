// Public webhook endpoint for user-defined custom agents (Step 8).
//
// Trigger: POST /api/public/hooks/agent/{agentId}
// Auth   : header `x-agent-secret: <webhook_secret>` matched to custom_agents.webhook_secret
// Body   : { input: string, context?: unknown } — free-form user instruction
//
// Runs the agent with its custom system prompt + tool allow-list, records a
// webhook_events row, and returns the model's final text output.
//
// AI SDK deps are lazy-loaded to keep the SSR bundle small.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/hooks/agent/$agentId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const agentId = params.agentId;
        const secret = request.headers.get("x-agent-secret");
        if (!secret) return new Response("missing x-agent-secret header", { status: 401 });
        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("LOVABLE_API_KEY missing", { status: 500 });

        let body: { input?: string; context?: unknown } = {};
        try { body = await request.json(); } catch { /* allow empty body */ }
        const input = (body.input ?? "").toString().slice(0, 4000);
        if (!input) return new Response("missing input", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: agent, error } = await supabaseAdmin
          .from("custom_agents")
          .select("id,owner_id,name,system_prompt,tool_allowlist,active,webhook_enabled,webhook_secret")
          .eq("id", agentId)
          .maybeSingle();
        if (error) return new Response(error.message, { status: 500 });
        if (!agent) return new Response("agent not found", { status: 404 });
        if (!agent.active || !agent.webhook_enabled) return new Response("agent inactive", { status: 403 });

        // Constant-time compare.
        const a = new TextEncoder().encode(secret);
        const b = new TextEncoder().encode(agent.webhook_secret);
        let mismatch = a.length !== b.length ? 1 : 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++) mismatch |= a[i] ^ b[i];
        if (mismatch) return new Response("bad secret", { status: 401 });

        const sourceIp =
          request.headers.get("cf-connecting-ip") ??
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          null;

        const t0 = Date.now();
        try {
          const [{ generateText, stepCountIs, tool: mkTool }, { createLovableAiGatewayProvider }, { z }, runsMod] =
            await Promise.all([
              import("ai"),
              import("@/lib/ai-gateway.server"),
              import("zod"),
              import("@/lib/agent-runs.server"),
            ]);
          const gateway = createLovableAiGatewayProvider(key);
          const model = gateway("google/gemini-3-flash-preview");

          const run = await runsMod.startAgentRun({
            agent: `custom:${agent.name}`,
            trigger: "webhook",
            actorId: agent.owner_id,
            input: { input, source_ip: sourceIp },
          });

          // Whitelisted stub tools — the model can "call" them and we record the call,
          // but no side effects fire. This is intentionally sandboxed for external
          // callers; extend later once you trust the caller pattern.
          const allowed = new Set(agent.tool_allowlist ?? []);
          const called: Array<{ name: string; input: unknown }> = [];
          const tools = Object.fromEntries(
            [...allowed].map((name) => [
              name,
              mkTool({
                description: `custom-agent tool ${name}`,
                inputSchema: z.object({}).passthrough(),
                execute: async (i: unknown) => {
                  called.push({ name, input: i });
                  return { stub: true, note: "external tools are sandboxed for now" };
                },
              }),
            ]),
          );

          const res = await generateText({
            model,
            system: agent.system_prompt,
            prompt: input,
            tools: allowed.size > 0 ? tools : undefined,
            stopWhen: stepCountIs(6),
          });

          const output = res.text ?? "";
          await runsMod.finishAgentRun(run, {
            status: "succeeded",
            output: { text_length: output.length, tools: called },
            tokensIn: res.usage?.inputTokens,
            tokensOut: res.usage?.outputTokens,
          });

          await supabaseAdmin.from("webhook_events").insert({
            agent_id: agent.id,
            source_ip: sourceIp,
            payload: body as never,
            status: "ok",
            run_id: run?.id ?? null,
            output: output.slice(0, 4000),
            latency_ms: Date.now() - t0,
          });
          await supabaseAdmin
            .from("custom_agents")
            .update({ last_run_at: new Date().toISOString(), run_count: 1 + (0) })
            .eq("id", agent.id);
          // Increment via RPC-less path: fetch & write. Best-effort.
          try {
            const { data: fresh } = await supabaseAdmin
              .from("custom_agents").select("run_count").eq("id", agent.id).single();
            if (fresh) {
              await supabaseAdmin
                .from("custom_agents")
                .update({ run_count: (fresh.run_count ?? 0) + 1 })
                .eq("id", agent.id);
            }
          } catch { /* best-effort */ }

          return new Response(
            JSON.stringify({ ok: true, output, tools_called: called, run_id: run?.id ?? null }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await supabaseAdmin.from("webhook_events").insert({
            agent_id: agent.id,
            source_ip: sourceIp,
            payload: body as never,
            status: "error",
            error: msg,
            latency_ms: Date.now() - t0,
          });
          return new Response(JSON.stringify({ ok: false, error: msg }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      },
    },
  },
});
