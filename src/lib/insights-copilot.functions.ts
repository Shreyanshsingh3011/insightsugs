import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Gemini-powered routing + phrasing for the Insights copilot.
 *
 * Hard rule: the model NEVER computes numbers. It only:
 *   1) picks one backend endpoint + params (routeInsightQuestion)
 *   2) phrases the returned payload's numbers verbatim (phraseInsightAnswer)
 */

const MODEL = "google/gemini-2.5-flash";
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

type SheetMeta = {
  label: string;
  type?: string;
  row_count?: number;
  columns?: { name: string; type?: string }[];
  available_dimensions?: string[];
  available_measures?: string[];
};

type RouteResult = {
  endpoint:
    | "dashboard"
    | "pivot"
    | "anomalies"
    | "quality"
    | "whatif"
    | "forecast"
    | "trends"
    | "copilot"
    | "none";
  params?: Record<string, string>;
  sheet?: string;
  reason?: string;
};

async function callGateway(body: Record<string, unknown>): Promise<string> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY is not configured");
  const r = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429) throw new Error("Rate limit exceeded. Please try again shortly.");
  if (r.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
  if (!r.ok) throw new Error(`AI gateway HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content?.trim() || "";
}

function extractJson(s: string): unknown {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : s).trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch { /* fallthrough */ }
  }
  return JSON.parse(text);
}

export const routeInsightQuestion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { question: string; sheets: SheetMeta[] }) => {
    if (!input?.question || !Array.isArray(input?.sheets)) {
      throw new Error("question and sheets are required");
    }
    return input;
  })
  .handler(async ({ data }): Promise<RouteResult> => {
    const catalog = data.sheets.map((s) => ({
      label: s.label,
      type: s.type,
      row_count: s.row_count,
      columns: (s.columns || []).map((c) => ({ name: c.name, type: c.type })),
      available_dimensions: s.available_dimensions || [],
      available_measures: s.available_measures || [],
    }));

    const system = [
      "You are a strict ROUTER for an analytics backend. You never compute, estimate, or output numbers.",
      "Pick exactly ONE endpoint that best answers the user's question using ONLY column names present in the provided sheet catalog.",
      "Endpoints:",
      "- dashboard: high-level KPIs/charts/modules per sheet. Use for generic summary/overview/quality questions.",
      '- pivot { dimension, measure, agg: "sum"|"avg"|"count", sheet }: exact group-by. Use for "X by Y", "sum/avg/count of <measure> per <dimension>", "which <dimension> has most/least <measure>". For pure counts use measure=dimension and agg="count".',
      "- anomalies { sheet }: outlier rows.",
      "- quality { sheet }: data quality report.",
      "- whatif { sheet }: scenario module.",
      "- forecast { sheet }: time-series forecast (only if a date column exists).",
      "- trends { sheet }: trend analysis (only if a date column exists).",
      "- none: question cannot be answered from catalog.",
      "Rules:",
      "- Use a column name ONLY if it appears EXACTLY in that sheet's columns list.",
      "- If multiple sheets fit, pick the one whose columns best match the question; default to the first sheet.",
      "- Output strict minified JSON with keys: endpoint, params (object, may be empty), sheet (optional), reason (short).",
      "- Do NOT include any numeric values, prose, or markdown. JSON only.",
    ].join("\n");

    const user = [
      "QUESTION:",
      data.question,
      "",
      "SHEET CATALOG (JSON):",
      JSON.stringify(catalog),
      "",
      'Respond with JSON like: {"endpoint":"pivot","params":{"dimension":"<col>","measure":"<col>","agg":"sum"},"sheet":"<label>","reason":"..."}',
    ].join("\n");

    const content = await callGateway({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 256,
      response_format: { type: "json_object" },
    });

    let parsed: RouteResult;
    try {
      parsed = extractJson(content) as RouteResult;
    } catch {
      return { endpoint: "none", reason: "router returned invalid JSON" };
    }
    if (!parsed?.endpoint) parsed = { endpoint: "none", reason: "no endpoint" };
    return parsed;
  });

export const phraseInsightAnswer = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      question: string;
      endpoint: string;
      params?: Record<string, unknown>;
      sheet?: string;
      payload: unknown;
    }) => {
      if (!input?.question) throw new Error("question required");
      return input;
    }
  )
  .handler(async ({ data }): Promise<{ text: string }> => {
    // Trim payload defensively so we keep tokens small.
    let payloadStr = JSON.stringify(data.payload ?? null);
    if (payloadStr.length > 12000) payloadStr = payloadStr.slice(0, 12000) + "…";

    const system = [
      "You write a brief, plain-English answer to the user's question using ONLY the numbers/values present in the PAYLOAD below.",
      "ABSOLUTE RULES:",
      "- Quote every number verbatim from the payload — never round, recompute, sum, average, rank, or invent values.",
      "- If the payload does not contain what's needed to answer, say so plainly. Do not guess.",
      "- Keep the answer under ~120 words. Use a short list or table if it helps; otherwise prose.",
      "- Do not mention 'payload', 'endpoint', or internal mechanics.",
    ].join("\n");

    const user = [
      `QUESTION: ${data.question}`,
      `SOURCE: endpoint=${data.endpoint}${data.sheet ? `, sheet=${data.sheet}` : ""}${
        data.params ? `, params=${JSON.stringify(data.params)}` : ""
      }`,
      "PAYLOAD (authoritative; numbers must be used verbatim):",
      payloadStr,
    ].join("\n");

    const content = await callGateway({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      max_tokens: 400,
    });

    return { text: content || "No answer." };
  });
