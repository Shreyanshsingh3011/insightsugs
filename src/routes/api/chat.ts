// Streaming chat endpoint for the AgentDashboard chatbot.
//
// The dashboard is client-side (data fetched from external sheets in the
// browser), so the client passes a compact `context` snapshot of the current
// project's rows/rankings/flags with each request. Read-only tools operate
// on that snapshot; write tools (added in step 3) will queue pending_actions.
import { createFileRoute } from "@tanstack/react-router";
import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  createLovableAiGatewayProvider,
  getLovableAiGatewayRunId,
} from "@/lib/ai-gateway.server";
import {
  startAgentRun,
  finishAgentRun,
  recordToolCall,
} from "@/lib/agent-runs.server";

type Ctx = {
  projectId?: string;
  projectLabel?: string;
  rows?: Array<Record<string, unknown>>;
  personRanking?: Array<{
    person: string;
    delay_count: number;
    total_overdue_days: number;
    activities?: string[];
  }>;
  tatRows?: Array<{
    activity: string;
    tat?: number | null;
    days_taken?: number | null;
    delta?: number | null;
    status?: string;
    person?: string;
  }>;
  flags?: Array<{
    id?: string;
    activity: string;
    severity?: string;
    status?: string;
    stage?: string;
    reason?: string;
    reason_text?: string;
    flagged_to?: { person?: string };
  }>;
  totals?: Record<string, number>;
  riskScore?: number;
};

function pick(r: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}

function buildTools(
  ctx: Ctx,
  run: { id?: string; toolCalls: Array<{ name: string; input: unknown; output?: unknown; ms?: number }> } | null,
  actorId: string | null,
) {
  const timed = <T,>(name: string, input: unknown, fn: () => T): T => {
    const t0 = Date.now();
    const out = fn();
    recordToolCall(run, { name, input, output: out, ms: Date.now() - t0 });
    return out;
  };

  const queueAction = async (kind: string, title: string, summary: string, rationale: string, payload: unknown) => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("pending_actions")
        .insert({
          kind,
          title,
          summary,
          rationale,
          payload: payload as never,
          proposed_by: actorId,
          run_id: run?.id ?? null,
          status: "pending",
        })
        .select("id")
        .single();
      if (error) return { queued: false, error: error.message };
      return { queued: true, action_id: data?.id, review_url: "/agent/approvals" };
    } catch (e) {
      return { queued: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    getDashboardSummary: tool({
      description:
        "Returns headline totals for the currently selected project: row count, delayed/at-risk/completed counts, and overall risk score. Use this first for any high-level question.",
      inputSchema: z.object({}),
      execute: async () =>
        timed("getDashboardSummary", {}, () => ({
          project: ctx.projectLabel ?? ctx.projectId ?? "unknown",
          totals: ctx.totals ?? {},
          risk_score: ctx.riskScore ?? null,
          rows_available: ctx.rows?.length ?? 0,
          people_tracked: ctx.personRanking?.length ?? 0,
          open_flags: ctx.flags?.length ?? 0,
        })),
    }),

    getPersonWorkload: tool({
      description:
        "Returns delay count, total overdue days, and top overdue activities for a specific person on the current project. Use for 'why is X behind' or 'what does X owe'.",
      inputSchema: z.object({
        person: z.string().describe("Person name — matched case-insensitively"),
      }),
      execute: async ({ person }) =>
        timed("getPersonWorkload", { person }, () => {
          const q = person.trim().toLowerCase();
          const hit = (ctx.personRanking ?? []).find((p) =>
            p.person.toLowerCase().includes(q),
          );
          if (!hit) return { found: false, person };
          const openItems = (ctx.flags ?? []).filter(
            (f) => (f.flagged_to?.person ?? "").toLowerCase().includes(q),
          );
          return {
            found: true,
            person: hit.person,
            delay_count: hit.delay_count,
            total_overdue_days: hit.total_overdue_days,
            top_activities: (hit.activities ?? []).slice(0, 5),
            open_flags: openItems.slice(0, 5).map((f) => ({
              id: f.id,
              activity: f.activity,
              severity: f.severity,
              reason: f.reason_text ?? f.reason,
              stage: f.stage,
            })),
          };
        }),
    }),

    topDelays: tool({
      description:
        "Returns the top N delayed activities on the current project, sorted by days overrun.",
      inputSchema: z.object({
        limit: z.number().describe("Max results, e.g. 5 or 10"),
      }),
      execute: async ({ limit }) =>
        timed("topDelays", { limit }, () => {
          const n = Math.max(1, Math.min(limit ?? 5, 25));
          const sorted = [...(ctx.tatRows ?? [])]
            .filter((r) => (r.delta ?? 0) > 0)
            .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
            .slice(0, n);
          return {
            count: sorted.length,
            items: sorted.map((r) => ({
              activity: r.activity,
              person: r.person,
              days_over: r.delta,
              tat: r.tat,
              actual: r.days_taken,
              status: r.status,
            })),
          };
        }),
    }),

    filterActivities: tool({
      description:
        "Filters raw activity rows on the current project by any combination of person, stage, status, or a free-text query on the activity name. Returns at most 20 matches.",
      inputSchema: z.object({
        person: z.string().nullable(),
        stage: z.string().nullable(),
        status: z.string().nullable(),
        query: z.string().nullable(),
      }),
      execute: async ({ person, stage, status, query }) =>
        timed(
          "filterActivities",
          { person, stage, status, query },
          () => {
            const q = (query ?? "").trim().toLowerCase();
            const p = (person ?? "").trim().toLowerCase();
            const s = (stage ?? "").trim().toLowerCase();
            const st = (status ?? "").trim().toLowerCase();
            const matches: Array<Record<string, string>> = [];
            for (const row of ctx.rows ?? []) {
              const activity = pick(row, "activity", "Activity", "task", "Task");
              const who = pick(row, "person", "Person", "assignee", "Assignee", "owner", "Owner");
              const stg = pick(row, "stage", "Stage", "phase", "Phase");
              const stt = pick(row, "status", "Status");
              if (p && !who.toLowerCase().includes(p)) continue;
              if (s && !stg.toLowerCase().includes(s)) continue;
              if (st && !stt.toLowerCase().includes(st)) continue;
              if (q && !activity.toLowerCase().includes(q)) continue;
              matches.push({ activity, person: who, stage: stg, status: stt });
              if (matches.length >= 20) break;
            }
            return { count: matches.length, items: matches };
          },
        ),
    }),

    getOpenAlerts: tool({
      description:
        "Returns the current project's open flags/alerts with severity, reason, and who they are flagged to. Use when the user asks about alerts, risks, or blockers.",
      inputSchema: z.object({
        severity: z.string().nullable().describe("Optional filter: 'critical', 'warning', 'info'"),
      }),
      execute: async ({ severity }) =>
        timed("getOpenAlerts", { severity }, () => {
          const sev = (severity ?? "").trim().toLowerCase();
          const items = (ctx.flags ?? [])
            .filter((f) => !sev || (f.severity ?? "").toLowerCase() === sev)
            .slice(0, 20)
            .map((f) => ({
              id: f.id,
              activity: f.activity,
              severity: f.severity,
              stage: f.stage,
              status: f.status,
              reason: f.reason_text ?? f.reason,
              flagged_to: f.flagged_to?.person,
            }));
          return { count: items.length, items };
        }),
    }),

    proposeCreateAlert: tool({
      description:
        "Propose a new alert for a specific delayed activity or person. This queues an approval request — the alert is NOT created until a human approves it in /agent/approvals. Use when the user says 'flag', 'raise alert', 'notify about', or clearly asks you to escalate.",
      inputSchema: z.object({
        activity: z.string().describe("Activity name to raise the alert on"),
        person: z.string().nullable().describe("Person to flag it to (optional)"),
        severity: z.enum(["info", "warning", "critical"]).describe("Alert severity"),
        reason: z.string().describe("One-sentence reason for the alert"),
      }),
      execute: async ({ activity, person, severity, reason }) => {
        const title = `Alert: ${activity}`;
        const summary = `${severity.toUpperCase()} — ${activity}${person ? ` (owner: ${person})` : ""}`;
        const res = await queueAction(
          "create_alert",
          title,
          summary,
          reason,
          { activity, person, severity, reason, project: ctx.projectLabel ?? ctx.projectId },
        );
        recordToolCall(run, { name: "proposeCreateAlert", input: { activity, person, severity }, output: res });
        return res;
      },
    }),

    proposeNudgeAssignee: tool({
      description:
        "Propose a short nudge message to an assignee about an overdue activity. Queues an approval — no message is sent until approved. Use when the user asks to 'ping', 'nudge', 'follow up with', or 'remind' a person.",
      inputSchema: z.object({
        person: z.string().describe("Person to nudge"),
        activity: z.string().describe("The overdue activity name"),
        message: z.string().describe("Draft message (1-2 sentences, friendly, specific)"),
      }),
      execute: async ({ person, activity, message }) => {
        const res = await queueAction(
          "nudge_assignee",
          `Nudge ${person}`,
          `Nudge ${person} about "${activity}"`,
          message,
          { person, activity, message, project: ctx.projectLabel ?? ctx.projectId },
        );
        recordToolCall(run, { name: "proposeNudgeAssignee", input: { person, activity }, output: res });
        return res;
      },
    }),
  };
}

const SYSTEM_PROMPT = `You are DelayLens Copilot, an agentic assistant for a construction project delay-tracking platform.

RULES:
- Answer ONLY from tool outputs and the dashboard context provided. Never invent names, numbers, or dates.
- For any question about specific people, delays, alerts, or activities, CALL A TOOL first. Do not answer from prior chat memory alone.
- If a tool returns no matching data, say so explicitly ("I don't see X in the current project data").
- Cite specifics: person names, activity names, day counts. Keep answers tight — bullets over prose.
- To ACT (create alert, nudge, escalate), call a proposeXxx tool. Never say "I'll send" or "I'll create" — those tools QUEUE a proposal for human approval. Tell the user: "Queued for your approval — review at /agent/approvals."

When you have enough information, produce a short, direct answer.`;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { messages?: UIMessage[]; context?: Ctx; actorId?: string | null } = {};
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return new Response("messages required", { status: 400 });
        }
        const key = process.env.LOVABLE_API_KEY;
        if (!key) {
          return new Response("LOVABLE_API_KEY missing", { status: 500 });
        }

        const ctx: Ctx = body.context ?? {};
        const runIdIncoming = getLovableAiGatewayRunId(request);
        const gateway = createLovableAiGatewayProvider(key, runIdIncoming);
        const model = gateway("google/gemini-3-flash-preview");

        const lastUser = messages[messages.length - 1];
        const lastText =
          lastUser?.parts
            ?.map((p) => (p.type === "text" ? p.text : ""))
            .join(" ")
            .slice(0, 500) ?? "";

        const run = await startAgentRun({
          agent: "chatbot",
          trigger: "chat",
          actorId: body.actorId ?? null,
          input: { question: lastText, project: ctx.projectLabel ?? ctx.projectId ?? null },
        });

        const tools = buildTools(ctx, run);

        try {
          const contextPreamble = `Current project: ${ctx.projectLabel ?? ctx.projectId ?? "unknown"}. Rows: ${ctx.rows?.length ?? 0}. People tracked: ${ctx.personRanking?.length ?? 0}. Open flags: ${ctx.flags?.length ?? 0}. Risk score: ${ctx.riskScore ?? "n/a"}.`;

          const modelMessages = await convertToModelMessages(messages);

          const result = streamText({
            model,
            system: `${SYSTEM_PROMPT}\n\n${contextPreamble}`,
            messages: modelMessages,
            tools,
            stopWhen: stepCountIs(50),
            onFinish: async ({ usage, text }) => {
              await finishAgentRun(run, {
                status: "succeeded",
                output: { text_length: text?.length ?? 0 },
                tokensIn: usage?.inputTokens,
                tokensOut: usage?.outputTokens,
              });
            },
            onError: async ({ error }) => {
              await finishAgentRun(run, {
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
              });
            },
          });

          return result.toUIMessageStreamResponse({
            originalMessages: messages,
          });
        } catch (e) {
          await finishAgentRun(run, {
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
          const msg = e instanceof Error ? e.message : "chat failed";
          return new Response(msg, { status: 500 });
        }
      },
    },
  },
});
