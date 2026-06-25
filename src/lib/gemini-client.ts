import { GoogleGenerativeAI } from "@google/generative-ai";

export const GEMINI_API_KEY = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) || "";
export const hasGemini = () => !!GEMINI_API_KEY;

let client: GoogleGenerativeAI | null = null;
function getClient() {
  if (!GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(GEMINI_API_KEY);
  return client;
}

export async function generateGemini(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
}): Promise<string> {
  const c = getClient();
  if (!c) throw new Error("VITE_GEMINI_API_KEY missing");
  const model = c.getGenerativeModel({
    model: "gemini-1.5-flash",
    ...(opts.system ? { systemInstruction: opts.system } : {}),
    generationConfig: { temperature: opts.temperature ?? 0.4 },
  });
  const res = await model.generateContent(opts.prompt);
  return res.response.text();
}

export const GROUNDING_RULES = [
  "STRICT GROUNDING RULES:",
  "- Use ONLY the numbers, facts, and values provided in the context below.",
  "- Never invent, estimate, round, or recompute any number.",
  "- If asked something the context cannot answer, say so plainly.",
  "- Mark any forward-looking advice clearly as a suggestion.",
].join("\n");
