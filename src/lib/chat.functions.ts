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

    const system = `You are a strict data-bound assistant for a project-delay analytics dashboard.

RULES:
- Answer ONLY using facts present in the JSON DATA below.
- If the answer is not derivable from the data, set "answer" to: "I don't have that in the current dashboard data." and return an empty "citations" array.
- Be concise. Use markdown bullets or small tables. Cite numbers exactly as they appear.
- For EVERY factual claim, add a citation pointing to the exact JSON path you used.

OUTPUT FORMAT — return ONLY raw JSON, no code fences, matching:
{
  "answer": "<markdown answer>",
  "citations": [
    {
      "source": "<json path, e.g. totals.delayed | person_ranking[0] | tat_performance.rows[2] | flags[FLAG-003] | top_delay_reasons[1] | status_breakdown.Delayed>",
      "label": "<short human label, e.g. 'Delayed total' or 'Top person by overdue days'>",
      "value": "<exact quoted value from the data, e.g. '47' or 'Pradeep S. Bhattacharya — 53 overdue days'>"
    }
  ]
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
      }
    } catch {
      // model didn't return JSON — fall back to raw text
    }

    return { answer, citations };
  });
