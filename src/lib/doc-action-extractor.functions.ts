// Document → Action Extractor
// Parses an ingested document (already chunked in `document_chunks`) and
// extracts obligations, deadlines, and penalties via Lovable AI. Each
// obligation becomes either:
//   • an `alerts` row (severity from time-to-deadline) — always
//   • a tracked `activities` row when a target project_id is supplied
// Every artefact carries a citation back to the source document + page.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Obligation = {
  title: string;
  description: string;
  owner_hint: string;
  due_date: string | null;  // ISO yyyy-mm-dd
  obligation_type: "deadline" | "penalty" | "deliverable" | "approval" | "payment" | "other";
  citation_page: number | null;
  citation_excerpt: string;
  severity: "info" | "warning" | "critical";
};

async function aiExtract(input: {
  docName: string;
  summary: string | null;
  chunks: { page: number | null; content: string }[];
}): Promise<Obligation[]> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return [];
  const chunkText = input.chunks
    .map(c => `[[page=${c.page ?? "?"}]]\n${c.content.slice(0, 1500)}`)
    .join("\n---\n")
    .slice(0, 14000);
  const prompt =
`Extract every actionable obligation, deadline, penalty clause, deliverable, approval, or payment from this document. Skip generic boilerplate. Return STRICT JSON only:
{"obligations":[{"title": string (<=80 chars), "description": string (1-2 sentences), "owner_hint": string (role or party), "due_date": string|null (yyyy-mm-dd if a specific date can be inferred, else null), "obligation_type": "deadline"|"penalty"|"deliverable"|"approval"|"payment"|"other", "citation_page": number|null, "citation_excerpt": string (verbatim quote <=200 chars supporting the obligation), "severity": "info"|"warning"|"critical"}]}

Rules: extract at most 20 obligations, most critical first. Only include an obligation if the excerpt clearly supports it. Prefer explicit dates over implied.

Document: ${input.docName}
Summary: ${input.summary ?? "(none)"}

Chunks (with page markers):
${chunkText}`;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You extract contractual obligations from documents. Return JSON only. Do not invent dates or clauses." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return [];
    const j: any = await res.json();
    const parsed = JSON.parse(j?.choices?.[0]?.message?.content ?? "{}");
    const list = Array.isArray(parsed?.obligations) ? parsed.obligations : [];
    return list
      .filter((o: any) => o && typeof o.title === "string" && typeof o.citation_excerpt === "string")
      .slice(0, 20)
      .map((o: any) => ({
        title: String(o.title).slice(0, 200),
        description: String(o.description ?? "").slice(0, 1000),
        owner_hint: String(o.owner_hint ?? "").slice(0, 120),
        due_date: typeof o.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.due_date) ? o.due_date : null,
        obligation_type: ["deadline","penalty","deliverable","approval","payment","other"].includes(o.obligation_type)
          ? o.obligation_type : "other",
        citation_page: typeof o.citation_page === "number" ? o.citation_page : null,
        citation_excerpt: String(o.citation_excerpt).slice(0, 400),
        severity: ["info","warning","critical"].includes(o.severity) ? o.severity : "info",
      })) as Obligation[];
  } catch { return []; }
}

function severityFromDate(iso: string | null, fallback: Obligation["severity"]): Obligation["severity"] {
  if (!iso) return fallback;
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  if (days < 3) return "critical";
  if (days < 14) return "warning";
  return fallback;
}

export type ExtractResult = {
  document_id: string;
  document_name: string;
  obligations_found: number;
  activities_created: number;
  alerts_created: number;
  notifications: number;
  obligations: Obligation[];
  errors: string[];
};

const ExtractInput = z.object({
  document_id: z.string().uuid(),
  project_id: z.string().uuid().optional().nullable(),
});

export const extractDocActions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ExtractInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<ExtractResult> => {
    const { userId, supabase } = context as { userId: string; supabase: any };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Access check via the RLS-scoped client.
    const { data: doc, error: dErr } = await supabase
      .from("documents")
      .select("id, name, summary, owner_id, folder_id, page_count")
      .eq("id", data.document_id)
      .maybeSingle();
    if (dErr) throw new Error(dErr.message);
    if (!doc) throw new Error("Document not found or not accessible");

    const { data: chunks } = await supabaseAdmin
      .from("document_chunks")
      .select("content, page_no")
      .eq("document_id", data.document_id)
      .order("chunk_index", { ascending: true })
      .limit(24);

    const obligations = await aiExtract({
      docName: doc.name,
      summary: doc.summary,
      chunks: (chunks ?? []).map((c: any) => ({ page: c.page_no, content: String(c.content ?? "") })),
    });

    const result: ExtractResult = {
      document_id: doc.id, document_name: doc.name, obligations_found: obligations.length,
      activities_created: 0, alerts_created: 0, notifications: 0,
      obligations, errors: [],
    };

    for (const ob of obligations) {
      const cite = `[${doc.name}${ob.citation_page ? `, p.${ob.citation_page}` : ""}] "${ob.citation_excerpt}"`;
      const severity = severityFromDate(ob.due_date, ob.severity);
      const description = [
        ob.description,
        "",
        `**Type:** ${ob.obligation_type}${ob.owner_hint ? ` · **Owner:** ${ob.owner_hint}` : ""}${ob.due_date ? ` · **Due:** ${ob.due_date}` : ""}`,
        "",
        `**Citation:** ${cite}`,
      ].join("\n");

      // Alert (always) — text-based, no project_id required.
      const flag_id = `doc-${doc.id.slice(0, 8)}-${ob.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40)}`;
      const { error: alertErr } = await supabaseAdmin.from("alerts").insert({
        flag_id,
        activity: ob.title,
        stage: ob.obligation_type,
        severity,
        source: `document:${doc.name}`,
        reason: description,
        status: "open",
        sent_by: userId,
      });
      if (!alertErr) result.alerts_created++;
      else if ((alertErr as any).code !== "23505") result.errors.push(`alert ${ob.title}: ${alertErr.message}`);

      // Activity (if a project target was given).
      if (data.project_id) {
        const { error: actErr } = await supabaseAdmin.from("activities").insert({
          project_id: data.project_id,
          title: ob.title,
          description,
          due_date: ob.due_date,
          status: "pending",
        });
        if (!actErr) result.activities_created++;
        else result.errors.push(`activity ${ob.title}: ${actErr.message}`);
      }

      // Notification to the document owner.
      const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
        user_id: doc.owner_id ?? userId,
        kind: "doc_obligation",
        title: `Obligation extracted: ${ob.title}`,
        body: description.slice(0, 800),
      });
      if (!notifErr) result.notifications++;
    }

    try {
      await supabaseAdmin.from("audit_log").insert({
        actor_id: userId,
        event_type: "doc_action_extractor.run",
        details: JSON.parse(JSON.stringify({
          document_id: doc.id, name: doc.name, project_id: data.project_id ?? null,
          found: obligations.length, activities: result.activities_created, alerts: result.alerts_created,
        })),
      });
    } catch {}

    return result;
  });
