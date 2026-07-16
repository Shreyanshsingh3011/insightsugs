// Multi-step planner endpoint. Streams a structured Plan (steps[]) from the
// LLM using AI SDK streamObject. The plan is proposal-only — nothing is
// executed here. The frontend calls approvePlan() (server function) with the
// finalized plan to bulk-queue pending_actions in a single approval step.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { startAgentRun, finishAgentRun } from "@/lib/agent-runs.server";

// Small, permissive schema so the model can produce plans without post-hoc
// validation failures. Names/limits are enforced in the prompt + clamped
// server-side when approvePlan runs.
export const PlanStepSchema = z.object({
  title: z.string().describe("Short imperative title, e.g. 'Flag Foundation slab delay'"),
  tool: z
    .enum(["create_alert", "nudge_assignee", "notify"])
    .describe("Which tool to invoke when this step is approved"),
  rationale: z.string().describe("Why this step is needed (1 sentence)"),
  payload: z
    .object({
      activity: z.string().nullable().describe("Activity name (for create_alert)"),
      person: z.string().nullable().describe("Assignee/recipient name"),
      severity: z.enum(["info", "warning", "critical"]).nullable(),
      message: z.string().nullable().describe("Nudge / notification body"),
      project: z.string().nullable(),
    })
    .describe("Tool-specific inputs; unused fields may be null"),
});

export const PlanSchema = z.object({
  summary: z.string().describe("One-paragraph explanation of the overall plan"),
  steps: z.array(PlanStepSchema).describe("Ordered steps to execute in sequence"),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;

const SYSTEM = `You are DelayLens Planner, a multi-step agent that decomposes a user's high-level goal
into a concrete, executable plan of 3 to 8 steps.

RULES:
- Each step must invoke exactly one tool: create_alert, nudge_assignee, or notify.
- Keep steps atomic — one action per step. Never bundle multiple flags into one step.
- Use the project context (rows, delays, flags) when provided. Cite real activity/person names.
- Never invent people or activities that aren't in the context. If context is empty, produce a
  generic scaffold plan and say so in the summary.
- Steps run in order; earlier steps' side effects can inform later steps.
- Keep rationales tight (one sentence). No fluff.`;

export const Route = createFileRoute("/api/agent/plan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          goal?: string;
          context?: Record<string, unknown>;
          actorId?: string | null;
        } = {};
        try { body = await request.json(); } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        const goal = (body.goal ?? "").trim();
        if (!goal) return new Response("goal required", { status: 400 });

        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("LOVABLE_API_KEY missing", { status: 500 });

        const [{ streamObject }, { createLovableAiGatewayProvider }] = await Promise.all([
          import("ai"),
          import("@/lib/ai-gateway.server"),
        ]);

        const gateway = createLovableAiGatewayProvider(key);
        const model = gateway("google/gemini-2.5-flash");

        const run = await startAgentRun({
          agent: "planner",
          trigger: "chat",
          actorId: body.actorId ?? null,
          input: { goal, context_keys: Object.keys(body.context ?? {}) },
        });

        const contextBlock = body.context
          ? `\n\nPROJECT CONTEXT (JSON):\n${truncateJsonForPrompt(body.context, 6000)}`
          : "\n\nNo project context provided.";

        try {
          const result = streamObject({
            model,
            schema: PlanSchema,
            system: SYSTEM,
            prompt: `Goal: ${goal}${contextBlock}\n\nProduce the plan now.`,
            onFinish: async ({ object, usage }) => {
              await finishAgentRun(run, {
                status: object ? "succeeded" : "failed",
                output: object ?? null,
                tokensIn: usage?.inputTokens,
                tokensOut: usage?.outputTokens,
              });
            },
          });
          const resp = result.toTextStreamResponse();
          if (run?.id) resp.headers.set("x-agent-run-id", run.id);
          return resp;
        } catch (e) {
          await finishAgentRun(run, {
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
          return new Response(e instanceof Error ? e.message : "plan failed", { status: 500 });
        }
      },
    },
  },
});
