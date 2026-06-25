import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  temperature: z.number().optional(),
});

export const generateGeminiFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY missing");
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: data.prompt }] }],
      generationConfig: { temperature: data.temperature ?? 0.4 },
    };
    if (data.system) {
      body.systemInstruction = { role: "system", parts: [{ text: data.system }] };
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return { text };
  });
