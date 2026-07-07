// Streaming chat endpoint for the AgentDashboard chatbot.
//
// The dashboard is client-side (data fetched from external sheets in the
// browser), so the client passes a compact `context` snapshot of the current
// project's rows/rankings/flags with each request. Read-only tools operate
// on that snapshot; write tools (added in step 3) will queue pending_actions.
import { createFileRoute } from "@tanstack/react-router";
import type { UIMessage, tool as ToolFn } from "ai";
import { z } from "zod";
const LOVABLE_AIG_RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";
function getLovableAiGatewayRunId(request: Request) {
  return request.headers.get(LOVABLE_AIG_RUN_ID_HEADER)?.trim() || undefined;
}

import {
  startAgentRun,
  finishAgentRun,
  recordToolCall,
} from "@/lib/agent-runs.server";
import { AGENT_REGISTRY, routeToAgent } from "@/lib/agent-registry";


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
  tool: typeof ToolFn,
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

    rememberFact: tool({
      description:
        "Save a durable fact or preference about this user for future sessions. Use sparingly — only when the user explicitly says 'remember', 'always', 'from now on', or reveals a stable preference.",
      inputSchema: z.object({
        kind: z.enum(["preference", "person", "project", "note"]).describe("Category"),
        key: z.string().describe("Short slug key, e.g. 'default_project'"),
        value: z.string().describe("The fact/preference in plain text"),
        importance: z.number().describe("1 = trivial, 5 = critical (default 2)"),
      }),
      execute: async ({ kind, key, value, importance }) => {
        if (!actorId) return { saved: false, reason: "not authenticated" };
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { error } = await supabaseAdmin.from("agent_memory").upsert(
            {
              user_id: actorId,
              kind,
              key: key.slice(0, 120),
              value: value.slice(0, 1000),
              importance: Math.max(1, Math.min(importance ?? 2, 5)),
              source: "chatbot",
            },
            { onConflict: "user_id,kind,key" },
          );
          const out = error ? { saved: false, error: error.message } : { saved: true };
          recordToolCall(run, { name: "rememberFact", input: { kind, key }, output: out });
          return out;
        } catch (e) {
          return { saved: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),

    queryProjects: tool({
      description:
        "List projects/sheets visible to the current user with row counts and last-refresh time. Use to answer 'which projects are late', 'show me all projects', or when the user names a project other than the currently-loaded one so you can identify it before drilling in.",
      inputSchema: z.object({
        query: z.string().nullable().describe("Optional case-insensitive name filter"),
        limit: z.number().nullable().describe("Max results (default 20)"),
      }),
      execute: async ({ query, limit }) => {
        const t0 = Date.now();
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          let q = supabaseAdmin
            .from("sheet_registry")
            .select("id, display_name, sheet_type, row_count, last_refreshed_at, user_id, visibility")
            .order("last_refreshed_at", { ascending: false, nullsFirst: false })
            .limit(Math.max(1, Math.min(limit ?? 20, 50)));
          if (actorId) {
            q = q.or(`user_id.eq.${actorId},visibility.eq.shared,visibility.eq.public`);
          } else {
            q = q.eq("visibility", "public");
          }
          if (query && query.trim()) {
            q = q.ilike("display_name", `%${query.trim()}%`);
          }
          const { data, error } = await q;
          const out = error
            ? { error: error.message, items: [] }
            : {
                count: data?.length ?? 0,
                current_project: ctx.projectLabel ?? ctx.projectId ?? null,
                items: (data ?? []).map((r) => ({
                  id: r.id,
                  name: r.display_name,
                  type: r.sheet_type,
                  rows: r.row_count,
                  last_refreshed: r.last_refreshed_at,
                  is_current: r.id === ctx.projectId,
                })),
              };
          recordToolCall(run, { name: "queryProjects", input: { query, limit }, output: out, ms: Date.now() - t0 });
          return out;
        } catch (e) {
          const out = { error: e instanceof Error ? e.message : String(e), items: [] };
          recordToolCall(run, { name: "queryProjects", input: { query, limit }, output: out, ms: Date.now() - t0 });
          return out;
        }
      },
    }),

    investigateDelay: tool({
      description:
        "Root-cause an overdue activity: joins the TAT breach, owner workload, and any related open flags on the current project. Use for 'why is X late', 'what's blocking Y', 'who should I nudge about Z'. Returns a structured finding; follow up with createAlert / draftEmail / scheduleStandup as needed.",
      inputSchema: z.object({
        activity: z.string().describe("Activity name (case-insensitive substring match)"),
      }),
      execute: async ({ activity }) =>
        timed("investigateDelay", { activity }, () => {
          const q = activity.trim().toLowerCase();
          const tat = (ctx.tatRows ?? []).find((r) => r.activity?.toLowerCase().includes(q));
          if (!tat) return { found: false, activity };
          const owner = tat.person ?? "";
          const ownerStats = (ctx.personRanking ?? []).find(
            (p) => owner && p.person.toLowerCase().includes(owner.toLowerCase()),
          );
          const relatedFlags = (ctx.flags ?? [])
            .filter(
              (f) =>
                f.activity?.toLowerCase().includes(q) ||
                (owner && (f.flagged_to?.person ?? "").toLowerCase().includes(owner.toLowerCase())),
            )
            .slice(0, 5)
            .map((f) => ({
              id: f.id,
              activity: f.activity,
              severity: f.severity,
              reason: f.reason_text ?? f.reason,
              stage: f.stage,
              status: f.status,
            }));
          const daysOver = tat.delta ?? 0;
          const severity = daysOver > 10 ? "critical" : daysOver > 3 ? "warning" : "info";
          return {
            found: true,
            activity: tat.activity,
            owner: owner || null,
            tat_days: tat.tat,
            actual_days: tat.days_taken,
            days_over: daysOver,
            status: tat.status,
            suggested_severity: severity,
            owner_workload: ownerStats
              ? {
                  delay_count: ownerStats.delay_count,
                  total_overdue_days: ownerStats.total_overdue_days,
                  is_top_offender: (ctx.personRanking ?? [])[0]?.person === ownerStats.person,
                }
              : null,
            related_flags: relatedFlags,
            recommendation:
              daysOver > 10
                ? `Escalate: raise a critical alert and draft an email to ${owner || "the owner"}.`
                : daysOver > 3
                  ? `Nudge ${owner || "the owner"} and consider scheduling a standup.`
                  : `Monitor; owner may recover without intervention.`,
          };
        }),
    }),

    createAlert: tool({
      description:
        "Queue an alert proposal for human approval at /agent/approvals. Use when the user says 'create alert', 'raise alert', or 'flag'.",
      inputSchema: z.object({
        activity: z.string().describe("Activity name to raise the alert on"),
        person: z.string().nullable().describe("Person to flag it to (optional)"),
        severity: z.enum(["info", "warning", "critical"]).describe("Alert severity"),
        reason: z.string().describe("One-sentence reason for the alert"),
      }),
      execute: async ({ activity, person, severity, reason }) => {
        const res = await queueAction(
          "create_alert",
          `Alert: ${activity}`,
          `${severity.toUpperCase()} — ${activity}${person ? ` (owner: ${person})` : ""}`,
          reason,
          { activity, person, severity, reason, project: ctx.projectLabel ?? ctx.projectId },
        );
        recordToolCall(run, { name: "createAlert", input: { activity, person, severity }, output: res });
        return res;
      },
    }),

    draftEmail: tool({
      description:
        "Draft an email to an assignee/stakeholder about a delay or blocker. Queues the draft for human review — NO email is sent until approved at /agent/approvals. Use for 'email X about Y', 'send a follow-up', or after investigateDelay flags a critical breach.",
      inputSchema: z.object({
        to: z.string().describe("Recipient name (owner/assignee)"),
        subject: z.string().describe("Email subject line"),
        body: z.string().describe("Email body — professional, specific, references the activity and days overdue"),
        activity: z.string().nullable().describe("Related activity name for traceability"),
      }),
      execute: async ({ to, subject, body, activity }) => {
        const res = await queueAction(
          "draft_email",
          `Email draft to ${to}`,
          subject,
          activity ? `Regarding: ${activity}` : "Follow-up email",
          { to, subject, body, activity, project: ctx.projectLabel ?? ctx.projectId },
        );
        recordToolCall(run, { name: "draftEmail", input: { to, subject, activity }, output: res });
        return res;
      },
    }),

    scheduleStandup: tool({
      description:
        "Propose a standup/sync meeting to unblock a delayed activity or group. Queues for human approval — no calendar invite is sent automatically.",
      inputSchema: z.object({
        title: z.string().describe("Meeting title"),
        attendees: z.array(z.string()).describe("Attendee names"),
        when: z.string().describe("Proposed time in natural language, e.g. 'tomorrow 10am' or '2026-07-08T10:00'"),
        agenda: z.string().describe("Short agenda (1-3 bullets)"),
      }),
      execute: async ({ title, attendees, when, agenda }) => {
        const res = await queueAction(
          "schedule_standup",
          title,
          `Standup with ${attendees.join(", ")} — ${when}`,
          agenda,
          { title, attendees, when, agenda, project: ctx.projectLabel ?? ctx.projectId },
        );
        recordToolCall(run, { name: "scheduleStandup", input: { title, attendees, when }, output: res });
        return res;
      },
    }),

    summarizeThread: tool({
      description:
        "Generate a decision-ready brief for a specific concern or alert. Pulls the thread, participants, and keyword-matched linked documents; returns a 2-3 sentence brief, key bullets, and a recommended decision. Use when the user asks to 'summarize this concern', 'brief me on alert X', or 'what should we do about #<id>'. The `matchMode` argument controls document recall: 'keyword' (default) matches on the activity keyword only; 'expanded' also matches participant names / severity — pass 'expanded' when the user asks for a wider or fuller brief.",
      inputSchema: z.object({
        kind: z.enum(["concern", "alert"]).describe("Which thread type to summarize"),
        id: z.string().uuid().describe("The concern or alert UUID"),
        matchMode: z
          .enum(["keyword", "expanded"])
          .nullable()
          .describe("Linked-document match mode. Default 'keyword'."),
      }),
      execute: async ({ kind, id, matchMode }) => {
        const t0 = Date.now();
        try {
          const [{ summarizeThreadCore }, { supabaseAdmin }] = await Promise.all([
            import("@/lib/agent-briefs-core.server"),
            import("@/integrations/supabase/client.server"),
          ]);
          const res = await summarizeThreadCore(supabaseAdmin, {
            kind,
            id,
            matchMode: matchMode ?? "keyword",
          });
          recordToolCall(run, { name: "summarizeThread", input: { kind, id, matchMode }, output: res, ms: Date.now() - t0 });
          return res;
        } catch (e) {
          const err = { ok: false as const, error: e instanceof Error ? e.message : String(e) };
          recordToolCall(run, { name: "summarizeThread", input: { kind, id, matchMode }, output: err, ms: Date.now() - t0 });
          return err;
        }
      },
    }),

    generateStatusReport: tool({
      description:
        "Snapshot a project's status: totals (activities, overdue, blocked, open alerts/concerns), top overdue activities, and a 3-paragraph executive brief. Read-only — does NOT send email. Use when the user asks 'give me a status report for project X' or 'how is project Y doing'.",
      inputSchema: z.object({
        project_id: z.string().uuid().describe("The project UUID to report on"),
      }),
      execute: async ({ project_id }) => {
        const t0 = Date.now();
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: project } = await supabaseAdmin
            .from("projects")
            .select("id, name")
            .eq("id", project_id)
            .maybeSingle();
          if (!project) {
            const err = { ok: false as const, error: "Project not found" };
            recordToolCall(run, { name: "generateStatusReport", input: { project_id }, output: err, ms: Date.now() - t0 });
            return err;
          }
          const today = new Date().toISOString().slice(0, 10);
          const { data: acts } = await supabaseAdmin
            .from("activities")
            .select("id, title, status, due_date, assignee_id")
            .eq("project_id", project_id)
            .limit(500);
          const rows = acts ?? [];
          const overdueRows = rows
            .filter((a) => a.status !== "completed" && a.due_date && a.due_date < today)
            .map((a) => ({
              title: a.title,
              days_over: Math.max(
                0,
                Math.floor((Date.now() - new Date(a.due_date as string).getTime()) / 86_400_000),
              ),
            }))
            .sort((x, y) => y.days_over - x.days_over)
            .slice(0, 8);
          const out = {
            ok: true as const,
            project: { id: project.id, name: project.name },
            totals: {
              activities: rows.length,
              completed: rows.filter((a) => a.status === "completed").length,
              overdue: overdueRows.length,
              blocked: rows.filter((a) => a.status === "blocked").length,
            },
            top_overdue: overdueRows,
            note: "For a full PDF/email version, open the project on /projects and click 'Status report'.",
          };
          recordToolCall(run, { name: "generateStatusReport", input: { project_id }, output: out, ms: Date.now() - t0 });
          return out;
        } catch (e) {
          const err = { ok: false as const, error: e instanceof Error ? e.message : String(e) };
          recordToolCall(run, { name: "generateStatusReport", input: { project_id }, output: err, ms: Date.now() - t0 });
          return err;
        }
      },
    }),
  };
}


const SYSTEM_PROMPT = `You are DelayLens Copilot — an agentic assistant for a construction project delay-tracking platform.

You are an AGENT, not a Q&A bot. For any non-trivial question:
  1. THINK about what you need to know.
  2. CALL TOOLS to gather it — chain multiple tool calls in one turn when needed.
  3. For "why is Project X late and who should I nudge?" style questions the canonical loop is:
       queryProjects (if the project isn't the current one) → investigateDelay (or topDelays + getPersonWorkload) → propose a followup (createAlert / draftEmail / scheduleStandup).
  4. Only then produce a short, direct answer that cites the specific findings.

RULES:
- Answer ONLY from tool outputs and the dashboard context provided. Never invent names, numbers, or dates.
- For any question about specific people, projects, delays, alerts, or activities, CALL A TOOL first.
- If a tool returns no matching data, say so explicitly ("I don't see X in the current project data").
- Cite specifics: person names, activity names, day counts. Prefer bullets over prose.
- Write tools (createAlert / draftEmail / scheduleStandup / proposeCreateAlert / proposeNudgeAssignee) QUEUE proposals for human approval — they never send or create anything directly. When you use one, tell the user: "Queued for your approval — review at /agent/approvals."
- Chain up to ~50 tool steps when it produces a better answer, but stop as soon as you have enough.`;

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

        // Lazy-load heavy modules (ai SDK + gateway provider) only when needed
        // — keeps them out of the SSR entry bundle.
        const [
          { convertToModelMessages, streamText, stepCountIs, tool },
          { createLovableAiGatewayProvider },
        ] = await Promise.all([
          import("ai"),
          import("@/lib/ai-gateway.server"),
        ]);
        const gateway = createLovableAiGatewayProvider(key, runIdIncoming);
        const model = gateway("google/gemini-3-flash-preview");


        const lastUser = messages[messages.length - 1];
        const lastText =
          lastUser?.parts
            ?.map((p) => (p.type === "text" ? p.text : ""))
            .join(" ")
            .slice(0, 500) ?? "";

        // Route to the right specialist based on the latest user message.
        const routedTo = routeToAgent(lastText);
        const agentSpec = AGENT_REGISTRY[routedTo];

        const run = await startAgentRun({
          agent: `chatbot:${routedTo}`,
          trigger: "chat",
          actorId: body.actorId ?? null,
          input: { question: lastText, project: ctx.projectLabel ?? ctx.projectId ?? null, routed_to: routedTo },
        });

        // Persist routing metadata for observability.
        if (run?.id) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin
              .from("agent_runs")
              .update({ routed_to: routedTo })
              .eq("id", run.id);
          } catch { /* best-effort */ }
        }

        const allTools = buildTools(ctx, run, body.actorId ?? null, tool);
        const tools = Object.fromEntries(
          Object.entries(allTools).filter(([name]) => agentSpec.toolAllowList.includes(name)),
        );

        // Load top user memories (best-effort).
        let memoryBlock = "";
        if (body.actorId) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data: mem } = await supabaseAdmin
              .from("agent_memory")
              .select("kind,key,value,importance")
              .eq("user_id", body.actorId)
              .order("importance", { ascending: false })
              .order("updated_at", { ascending: false })
              .limit(15);
            if (mem && mem.length > 0) {
              memoryBlock =
                "\n\nKNOWN USER FACTS (from memory — respect these):\n" +
                mem.map((m) => `- [${m.kind}:${m.key}] ${m.value}`).join("\n");
            }
          } catch { /* best-effort */ }
        }

        // Load user's summarizeThread match-mode preference (dashboard toggle).
        let matchModeBlock = "";
        if (body.actorId) {
          try {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            const { data: pref } = await supabaseAdmin
              .from("agent_preferences")
              .select("value")
              .eq("user_id", body.actorId)
              .eq("key", "brief_match_mode")
              .maybeSingle();
            const mode =
              pref?.value && typeof pref.value === "object" && "mode" in (pref.value as object)
                ? (pref.value as { mode?: string }).mode
                : "keyword";
            if (mode === "expanded") {
              matchModeBlock =
                "\n\nUSER PREFERENCE: When calling summarizeThread, default matchMode='expanded' unless the user explicitly asks for a tight/keyword brief.";
            }
          } catch { /* best-effort */ }
        }




        // Emit a chat-started analytics event (best-effort, admin bypass).
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await supabaseAdmin.from("agent_run_events").insert({
            actor_id: body.actorId ?? null,
            agent: `chatbot:${routedTo}`,
            event: "chat_sent",
            run_id: run?.id ?? null,
            metadata: { project: ctx.projectLabel ?? ctx.projectId ?? null, chars: lastText.length, routed_to: routedTo },
          });
        } catch { /* best-effort */ }

        try {
          const contextPreamble = `Active agent: ${agentSpec.name} — ${agentSpec.purpose}\nCurrent project: ${ctx.projectLabel ?? ctx.projectId ?? "unknown"}. Rows: ${ctx.rows?.length ?? 0}. People tracked: ${ctx.personRanking?.length ?? 0}. Open flags: ${ctx.flags?.length ?? 0}. Risk score: ${ctx.riskScore ?? "n/a"}.${memoryBlock}${matchModeBlock}`;

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
                output: { text_length: text?.length ?? 0, routed_to: routedTo },
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

          const resp = result.toUIMessageStreamResponse({
            originalMessages: messages,
          });
          if (run?.id) resp.headers.set("x-agent-run-id", run.id);
          resp.headers.set("x-agent-routed-to", routedTo);
          return resp;
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
