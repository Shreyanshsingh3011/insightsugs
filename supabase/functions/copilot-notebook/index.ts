// Co-pilot Notebook edge function.
// Modes: chat | summarize_source | suggest_questions
// Math NEVER comes from the LLM. Numbers are computed client-side and passed in.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = "gemini-flash-latest";

type ContextItem = { tag: string; text: string };
type ChatHistoryItem = { role: "user" | "assistant"; content: string };

interface ChatBody {
  mode: "chat";
  token: string;
  question: string;
  mode_hint?: "quantitative" | "qualitative";
  computed_result?: { formatted: string; explanation?: string };
  context_items?: ContextItem[];
  history?: ChatHistoryItem[];
  citations_seed?: unknown[]; // for quantitative path
}

interface SummarizeBody {
  mode: "summarize_source";
  token: string;
  type: string;
  label: string;
  sample: unknown;
  row_count?: number;
}

interface SuggestBody {
  mode: "suggest_questions";
  token: string;
  enabled_sources: { type: string; label: string; columns?: string[]; row_count?: number }[];
}

type Body = ChatBody | SummarizeBody | SuggestBody;

async function callGemini(apiKey: string, system: string, userText: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { role: "system", parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Gemini ${r.status}: ${txt.slice(0, 300)}`);
  }
  const data = await r.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return text.trim();
}

// Parse [[Sheet:label|row:N]], [[Concern:id]], [[Reminder:id]] tags out of text.
function parseCitations(text: string): { stripped: string; citations: Record<string, unknown>[] } {
  const cites: Record<string, unknown>[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (raw.startsWith("Sheet:")) {
      const body = raw.slice("Sheet:".length);
      const [label, rowPart] = body.split("|");
      const rowMatch = /row:(\d+)/.exec(rowPart || "");
      cites.push({ type: "sheet", sheet: label, row: rowMatch ? Number(rowMatch[1]) : undefined });
    } else if (raw.startsWith("Concern:")) {
      cites.push({ type: "concern", id: raw.slice("Concern:".length) });
    } else if (raw.startsWith("Reminder:")) {
      cites.push({ type: "reminder", id: raw.slice("Reminder:".length) });
    }
  }
  const stripped = text.replace(re, "").replace(/[ \t]+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  // De-dup citations
  const seen = new Set<string>();
  const uniq = cites.filter((c) => {
    const k = JSON.stringify(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { stripped, citations: uniq };
}

async function getSupabaseAdmin() {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function persistMessages(
  token: string,
  rows: { role: string; content: string; citations?: unknown[]; generated_by?: string }[],
) {
  try {
    const sb = await getSupabaseAdmin();
    await sb.from("notebook_messages").insert(
      rows.map((r) => ({
        token,
        role: r.role,
        content: r.content,
        citations: r.citations ?? [],
        generated_by: r.generated_by ?? null,
      })),
    );
  } catch (e) {
    console.error("persistMessages failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY") || "";
  const offline = !apiKey;

  try {
    if (body.mode === "chat") {
      const { token, question, computed_result, context_items, history, citations_seed } = body;

      // 1) Quantitative path — we already have the exact answer.
      if (computed_result) {
        let text = computed_result.formatted;
        let generated_by: string = "computed";
        if (!offline) {
          try {
            const sys =
              "You are a data assistant. The user asked a numeric question. The exact answer has been COMPUTED for you. Write ONE short sentence that states this exact number in natural language. DO NOT change, round, or recompute the number. DO NOT add any other figures.";
            const usr = `Question: ${question}\nComputed answer: ${computed_result.formatted}${
              computed_result.explanation ? `\nDetail: ${computed_result.explanation}` : ""
            }\nReply with one sentence using the exact value above.`;
            const phrased = await callGemini(apiKey, sys, usr);
            if (phrased && phrased.includes(computed_result.formatted)) {
              text = phrased;
              generated_by = "computed+ai";
            }
          } catch (e) {
            console.warn("Phrasing failed, using raw computed answer", e);
          }
        }
        await persistMessages(token, [
          { role: "user", content: question },
          { role: "assistant", content: text, citations: citations_seed ?? [], generated_by },
        ]);
        return Response.json({ text, citations: citations_seed ?? [], generated_by, offline }, { headers: corsHeaders });
      }

      // 2) Qualitative path — answer strictly from context.
      const items = context_items ?? [];
      if (items.length === 0) {
        const text = "No sources are selected. Enable at least one source on the left to ask questions.";
        await persistMessages(token, [
          { role: "user", content: question },
          { role: "assistant", content: text, citations: [], generated_by: "computed" },
        ]);
        return Response.json({ text, citations: [], generated_by: "computed", offline }, { headers: corsHeaders });
      }

      if (offline) {
        // Extractive fallback: top items joined.
        const top = items.slice(0, 5).map((i) => `• ${i.text}`).join("\n");
        const text = `Based on the selected sources:\n${top}`;
        const cites = items.slice(0, 5).map((i) => parseCitations(i.tag).citations[0]).filter(Boolean);
        await persistMessages(token, [
          { role: "user", content: question },
          { role: "assistant", content: text, citations: cites, generated_by: "computed" },
        ]);
        return Response.json({ text, citations: cites, generated_by: "computed", offline }, { headers: corsHeaders });
      }

      const sys =
        "You are a careful notebook assistant. Answer using ONLY the provided context items. " +
        "Broad requests like 'summary', 'overview', or 'what is this' SHOULD be answered by summarizing the SHEET schema items and any concerns/reminders present — list each source briefly. " +
        "After each specific factual claim, append the matching tag exactly as given, e.g. [[Sheet:Cabling|row:14]] or [[Concern:abc]]. " +
        "If the user asks for a precise count, total, average, max, or min that is NOT already present in the context, reply: That requires a computation — please ask using the words 'how many' or 'total'. " +
        "If the answer is genuinely not in the context, reply exactly: That isn't in the selected sources. " +
        "Never invent numbers. Keep replies under 6 sentences.";
      const ctxText = items.map((i) => `${i.tag} ${i.text}`).join("\n");
      const hist = (history ?? []).slice(-6).map((h) => `${h.role}: ${h.content}`).join("\n");
      const usr = `Context items:\n${ctxText}\n\nConversation so far:\n${hist}\n\nUser question: ${question}`;

      let raw: string;
      let generated_by = "ai";
      try {
        raw = await callGemini(apiKey, sys, usr);
      } catch (e) {
        console.warn("Gemini qualitative failed, falling back", e);
        const top = items.slice(0, 3).map((i) => `${i.tag} ${i.text}`).join("\n");
        raw = top || "That isn't in the selected sources.";
        generated_by = "computed";
      }
      const { stripped, citations } = parseCitations(raw);
      const finalText = stripped || raw;
      await persistMessages(token, [
        { role: "user", content: question },
        { role: "assistant", content: finalText, citations, generated_by },
      ]);
      return Response.json({ text: finalText, citations, generated_by, offline }, { headers: corsHeaders });
    }

    if (body.mode === "summarize_source") {
      const { token, type, label, sample, row_count } = body;
      let summary = `${type === "sheet" ? `Sheet "${label}"` : type} with ${row_count ?? 0} item${(row_count ?? 0) === 1 ? "" : "s"}.`;
      if (!offline) {
        try {
          const sys = "Summarize this data source in 2–3 short factual sentences. Mention the row count and the most important column names. Do not invent values.";
          const usr = `Source type: ${type}\nLabel: ${label}\nRow count: ${row_count ?? 0}\nSample (JSON, may be truncated):\n${JSON.stringify(sample).slice(0, 4000)}`;
          summary = (await callGemini(apiKey, sys, usr)) || summary;
        } catch (e) {
          console.warn("summarize failed", e);
        }
      }
      try {
        const sb = await getSupabaseAdmin();
        await sb.from("notebook_sources").upsert(
          { token, type, label, summary, summary_generated_at: new Date().toISOString(), row_count: row_count ?? 0 },
          { onConflict: "token,type,label" },
        );
      } catch (e) {
        console.error("upsert source summary failed", e);
      }
      return Response.json({ summary, offline }, { headers: corsHeaders });
    }

    if (body.mode === "suggest_questions") {
      const { enabled_sources } = body;
      // Always-on deterministic fallback grounded in actual schema.
      const fallback: string[] = [];
      for (const s of enabled_sources) {
        if (s.type === "sheet") {
          const cols = (s.columns || []).slice(0, 4);
          const num = cols[1] || cols[0];
          if (num) fallback.push(`What is the total ${num} in ${s.label}?`);
          if (cols[0]) fallback.push(`Which ${cols[0]} has the most line items in ${s.label}?`);
        } else if (s.type === "concerns") {
          fallback.push("Summarize the open concerns.");
        } else if (s.type === "reminders") {
          fallback.push("Which reminders are pending?");
        }
      }
      let suggestions = fallback.slice(0, 6);
      if (!offline) {
        try {
          const sys = "Suggest 4–6 short, specific starter questions for a data notebook. Use ONLY the provided source labels and column names. Mix quantitative (how many/total/which has the most) and qualitative (summarize/what are the main issues) questions. Return one question per line, no numbering.";
          const usr = `Enabled sources:\n${JSON.stringify(enabled_sources, null, 2)}`;
          const raw = await callGemini(apiKey, sys, usr);
          const lines = raw.split(/\n+/).map((l) => l.replace(/^[\-\*\d\.\)\s]+/, "").trim()).filter((l) => l.length > 4);
          if (lines.length >= 2) suggestions = lines.slice(0, 6);
        } catch (e) {
          console.warn("suggest_questions failed", e);
        }
      }
      return Response.json({ suggestions, offline }, { headers: corsHeaders });
    }

    return Response.json({ error: "Unknown mode" }, { status: 400, headers: corsHeaders });
  } catch (e) {
    console.error("copilot-notebook error", e);
    return Response.json({ error: (e as Error).message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
});
