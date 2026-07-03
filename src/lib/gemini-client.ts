import { generateGeminiFn } from "@/lib/gemini.functions";

// Key lives server-side (GEMINI_API_KEY). Assume configured; callers will
// surface errors from the server fn if not.
export const hasGemini = () => true;

export async function generateGemini(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
}): Promise<string> {
  const res = await generateGeminiFn({ data: opts });
  return res.text;
}

export const GROUNDING_RULES = [
  "STRICT GROUNDING RULES:",
  "- Use ONLY the numbers, facts, and values provided in the DATA/context below.",
  "- Never invent, estimate, round, or recompute any number.",
  "- If the answer is not in the provided DATA, reply exactly: \"I don't have that in the current dashboard data.\" Do not guess.",
  "- Every factual sentence MUST cite the exact source using inline markers like [flags[F-0003]], [person_ranking[0].person], [tat_performance.rows[2].activity], or [sheet:<name> row <n>]. If you cannot cite it, do not say it.",
  "- End every answer with a `Sources:` list of the citation markers you used, one per line.",
  "- Mark any forward-looking advice clearly with the prefix \"Suggestion:\" and still cite the data points it is based on.",
].join("\n");

