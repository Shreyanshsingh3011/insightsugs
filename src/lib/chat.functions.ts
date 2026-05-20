import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway";

export interface Citation {
  source: string; // e.g. "totals.delayed", "person_ranking[0]", "tat_performance.rows[2]", "flags[FLAG-003]"
  label: string;  // human label e.g. "Delayed tasks"
  value: string;  // exact value/quote, e.g. "47" or "Pradeep S. Bhattacharya — 53d overdue"
}

export const askChatbot = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      question: string;
      dataJson: string;
      history: { role: "user" | "assistant"; content: string }[];
    }) => d,
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const system = `You are DelayLens Copilot — an AI analyst for a project-delay dashboard.

CAPABILITIES:
- Answer questions, summarize, and rank items strictly from the JSON DATA.
- Predictions: forecast which activities/people are likely to slip next, based on overdue_days, overrun_pct, escalation level, and reason frequency in the data.
- Advice: suggest concrete next actions (who to escalate to, which dependency to unblock first, which TAT to renegotiate). Tie every recommendation to a data point.
- Dependency reasoning: explain how a flagged activity blocks others using flags, stages, and shared owners visible in the data.
- Report generation: when the user asks for a report/export/download/CSV/PDF of flags, set "action" to "export_flags_pdf" or "export_flags_csv".

RULES:
- Use ONLY facts present in JSON DATA. If a fact is missing, say so — do not invent names, departments, or numbers.
- Mark inferences clearly: prefix predictions/advice lines with "Prediction:" or "Advice:".
- Be concise. Markdown bullets and small tables welcome.
- For EVERY factual claim, add a citation with the exact JSON path used.

OUTPUT FORMAT — return ONLY raw JSON, no code fences:
{
  "answer": "<markdown answer>",
  "citations": [
    { "source": "<json path, e.g. flags[FLAG-003] | tat_performance.rows[2] | person_ranking[0]>",
      "label": "<short human label>",
      "value": "<exact value from data>" }
  ],
  "action": "none" | "export_flags_pdf" | "export_flags_csv"
}

JSON DATA:
\`\`\`json
${data.dataJson}
\`\`\``;

    const { text } = await generateText({
      model,
      system,
      messages: [
        ...data.history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: data.question },
      ],
    });

    // Try to parse JSON (strip code fences if present)
    let answer = text;
    let citations: Citation[] = [];
    let action: "none" | "export_flags_pdf" | "export_flags_csv" = "none";
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (typeof parsed?.answer === "string") {
        answer = parsed.answer;
        if (Array.isArray(parsed.citations)) {
          citations = parsed.citations
            .filter((c: any) => c && typeof c === "object")
            .map((c: any) => ({
              source: String(c.source ?? ""),
              label: String(c.label ?? ""),
              value: String(c.value ?? ""),
            }));
        }
        if (parsed.action === "export_flags_pdf" || parsed.action === "export_flags_csv") {
          action = parsed.action;
        }
      }
    } catch {
      // model didn't return JSON — fall back to raw text
    }

    return { answer, citations, action };
  });
