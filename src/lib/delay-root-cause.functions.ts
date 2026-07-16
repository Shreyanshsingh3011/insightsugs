// Delay Root-Cause Agent
// When a delay flag / escalation is raised (agent_drafts row with rule
// "escalation"/"nudge", or an open alerts row without a root_cause), this
// agent pulls the relevant sheet row, its sibling rows (same project +
// same stage/activity keywords), related delay reasons on the sheet, and
// the top matching document chunks. Then Lovable AI synthesises a
// diagnosis + recommended actions. Results are written back to the
// draft.payload.diagnosis and, for alerts, to alerts.root_cause plus an
// alert_messages entry.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Row = Record<string, unknown>;

function pick(r: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}
function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchProjectRows(url: string): Promise<Row[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25_000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Row[] };
    return Array.isArray(json?.data) ? json.data : [];
  } finally { clearTimeout(t); }
}

function keywordTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4).slice(0, 6);
}

async function aiDiagnose(input: {
  project: string; activity: string; stage: string; delay: number;
  currentRow: Row; siblings: Row[]; docs: { name: string; page: number | null; excerpt: string }[];
  recordedReason: string;
}): Promise<{ root_cause: string; contributing_factors: string[]; recommended_actions: string[]; confidence: number }> {
  const key = process.env.LOVABLE_API_KEY;
  const fallback = {
    root_cause: input.recordedReason || `Root cause not yet diagnosed; ${input.delay}d slippage recorded.`,
    contributing_factors: input.siblings.length > 0 ? [`${input.siblings.length} sibling activities show similar slippage`] : [],
    recommended_actions: [
      "Confirm the current blocker with the assignee today",
      "Verify predecessor completion status",
      "Escalate to project lead if no committed ETA within 24h",
    ],
    confidence: 0.4,
  };
  if (!key) return fallback;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a construction PMO analyst. Diagnose delays crisply. Return JSON only." },
          { role: "user", content:
`Diagnose the root cause of this delay. Return STRICT JSON:
{"root_cause": string (1-2 sentences), "contributing_factors": string[] (max 4 concrete factors, cite doc name or sibling activity), "recommended_actions": string[] (max 5 imperative actions with owner), "confidence": number 0..1}

Context:
Project: ${input.project}
Activity: ${input.activity}
Stage: ${input.stage}
Delay: ${input.delay} days
Recorded reason on sheet: ${input.recordedReason || "(none)"}

Current row: ${JSON.stringify(input.currentRow).slice(0, 2000)}

Sibling rows in same project/stage (${input.siblings.length}):
${JSON.stringify(input.siblings.slice(0, 8)).slice(0, 3000)}

Related document excerpts (${input.docs.length}):
${input.docs.map(d => `- ${d.name} (p.${d.page ?? "?"}): ${d.excerpt.slice(0, 400)}`).join("\n").slice(0, 3000)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return fallback;
    const j: any = await res.json();
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    return {
      root_cause: String(parsed.root_cause ?? fallback.root_cause).slice(0, 1500),
      contributing_factors: Array.isArray(parsed.contributing_factors)
        ? parsed.contributing_factors.map(String).slice(0, 5) : fallback.contributing_factors,
      recommended_actions: Array.isArray(parsed.recommended_actions)
        ? parsed.recommended_actions.map(String).slice(0, 6) : fallback.recommended_actions,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : fallback.confidence,
    };
  } catch { return fallback; }
}

export type DiagnosisResult = {
  root_cause: string;
  contributing_factors: string[];
  recommended_actions: string[];
  confidence: number;
  sibling_count: number;
  doc_count: number;
};

async function investigateCore(opts: {
  draft_id?: string | null;
  alert_id?: string | null;
  actor_id: string | null;
}): Promise<DiagnosisResult & { subject: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let project = "", activity = "", stage = "", srNo = "", delay = 0, recordedReason = "";
  let alertRow: any = null;
  let draftRow: any = null;

  if (opts.draft_id) {
    const { data } = await supabaseAdmin.from("agent_drafts").select("*").eq("id", opts.draft_id).maybeSingle();
    if (!data) throw new Error("Draft not found");
    draftRow = data;
    const p = (data.payload ?? {}) as any;
    project = String(p.project ?? ""); activity = String(p.activity ?? "");
    stage = String(p.stage ?? ""); srNo = String(p.srNo ?? ""); delay = Number(p.delay ?? 0);
    recordedReason = String(p.reason ?? "");
  } else if (opts.alert_id) {
    const { data } = await supabaseAdmin.from("alerts").select("*").eq("id", opts.alert_id).maybeSingle();
    if (!data) throw new Error("Alert not found");
    alertRow = data;
    project = String(data.source ?? ""); activity = String(data.activity ?? "");
    stage = String(data.stage ?? ""); recordedReason = String(data.reason ?? "");
  } else {
    throw new Error("draft_id or alert_id required");
  }

  // Look up project URL from registry to fetch sibling rows.
  let currentRow: Row = {};
  let siblings: Row[] = [];
  try {
    const { loadAgentProjects } = await import("@/lib/agent-registry.functions");
    const reg = await loadAgentProjects();
    const p = reg.projects.find(x => x.label.toLowerCase() === project.toLowerCase());
    if (p) {
      const rows = await fetchProjectRows(p.url);
      const tokens = new Set(keywordTokens(activity + " " + stage));
      for (const r of rows) {
        const rActivity = pick(r, "Activity List", "Process Descriptions", "Process");
        const rSr = pick(r, "Sr. No.", "Sr No", "ID", "Id");
        if (srNo && rSr === srNo) currentRow = r;
        else {
          const rTokens = new Set(keywordTokens(rActivity + " " + pick(r, "Stages", "Stages of Process")));
          const overlap = Array.from(tokens).filter(t => rTokens.has(t)).length;
          if (overlap >= 2 && num(r["Delay in Days"]) > 0) siblings.push(r);
        }
      }
      siblings = siblings.slice(0, 12);
      if (!currentRow || Object.keys(currentRow).length === 0) {
        currentRow = rows.find(r => pick(r, "Activity List", "Process Descriptions").toLowerCase() === activity.toLowerCase()) ?? {};
      }
    }
  } catch { /* proceed without */ }

  // Find related documents by keyword search on chunks (title + activity).
  const docs: { name: string; page: number | null; excerpt: string }[] = [];
  try {
    const q = `${project} ${activity} ${stage}`.trim();
    const { data: chunks } = await supabaseAdmin
      .from("document_chunks")
      .select("content, page_no, documents!inner(name)")
      .textSearch("content", q.split(/\s+/).filter(Boolean).slice(0, 6).join(" | "), { type: "websearch" })
      .limit(6);
    for (const c of chunks ?? []) {
      docs.push({
        name: (c as any).documents?.name ?? "document",
        page: (c as any).page_no ?? null,
        excerpt: String((c as any).content ?? "").slice(0, 600),
      });
    }
  } catch { /* no search / no docs */ }

  const diagnosis = await aiDiagnose({
    project, activity, stage, delay: delay || num(currentRow["Delay in Days"]),
    currentRow, siblings, docs, recordedReason,
  });

  const subject = `Root cause — ${activity} (${project})`;
  const bodyMd = [
    `# ${subject}`, "",
    `**Root cause:** ${diagnosis.root_cause}`, "",
    "## Contributing factors",
    ...diagnosis.contributing_factors.map(f => `- ${f}`),
    "",
    "## Recommended actions",
    ...diagnosis.recommended_actions.map((a, i) => `${i + 1}. ${a}`),
    "",
    `_Confidence ${(diagnosis.confidence * 100).toFixed(0)}% · ${siblings.length} sibling rows · ${docs.length} doc excerpts_`,
  ].join("\n");

  // Persist back.
  if (draftRow) {
    const newPayload = { ...(draftRow.payload ?? {}), diagnosis, sibling_count: siblings.length, doc_count: docs.length };
    await supabaseAdmin.from("agent_drafts").update({
      payload: newPayload,
      why: `${draftRow.why ?? ""}\n[diagnosis] ${diagnosis.root_cause}`.slice(0, 2000),
    }).eq("id", draftRow.id);
  }
  if (alertRow) {
    await supabaseAdmin.from("alerts").update({
      root_cause: diagnosis.root_cause.slice(0, 1000),
    }).eq("id", alertRow.id);
    if (opts.actor_id) {
      await supabaseAdmin.from("alert_messages").insert({
        alert_id: alertRow.id,
        author_id: opts.actor_id,
        body: bodyMd,
      });
    }
  }

  return { ...diagnosis, sibling_count: siblings.length, doc_count: docs.length, subject };
}

const InvestigateInput = z.object({
  draft_id: z.string().uuid().optional(),
  alert_id: z.string().uuid().optional(),
});

export const investigateDelay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => InvestigateInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context as { userId: string; supabase: any };
    const { data: isAdmin } = await supabase.rpc("is_admin_or_super", { _user_id: userId });
    if (!isAdmin) throw new Error("Only admins can run the root-cause agent");
    return investigateCore({ draft_id: data.draft_id ?? null, alert_id: data.alert_id ?? null, actor_id: userId });
  });

/** Cron entry point — auto-investigates recent open alerts that have no root_cause yet. */
export async function runDelayRootCauseFromHook(): Promise<{ processed: number; errors: string[]; ids: string[] }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: alerts } = await supabaseAdmin
    .from("alerts")
    .select("id")
    .eq("status", "open")
    .is("root_cause", null)
    .order("created_at", { ascending: false })
    .limit(10);
  const errors: string[] = [];
  const ids: string[] = [];
  for (const a of alerts ?? []) {
    try {
      await investigateCore({ alert_id: (a as any).id, actor_id: null });
      ids.push((a as any).id);
    } catch (e) { errors.push(`${(a as any).id}: ${(e as Error).message}`); }
  }
  try {
    await supabaseAdmin.from("audit_log").insert({
      actor_id: null,
      event_type: "delay_root_cause.hook",
      details: JSON.parse(JSON.stringify({ processed: ids.length, errors, ids })),
    });
  } catch {}
  return { processed: ids.length, errors, ids };
}
