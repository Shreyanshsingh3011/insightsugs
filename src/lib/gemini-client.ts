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
  "- Use ONLY the numbers, facts, and values provided in the context below.",
  "- Never invent, estimate, round, or recompute any number.",
  "- If asked something the context cannot answer, say so plainly.",
  "- Mark any forward-looking advice clearly as a suggestion.",
].join("\n");
