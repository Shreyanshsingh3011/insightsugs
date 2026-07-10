import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { lovableAiFetchWithFallback } from "./ai-fallback.server";


const InputSchema = z.object({
  system: z.string().optional(),
  prompt: z.string(),
  temperature: z.number().optional(),
});

// Routes through Lovable AI Gateway (OpenAI-compatible) to avoid free-tier Gemini quota.
export const generateGeminiFn = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");

    const messages: Array<{ role: string; content: string }> = [];
    if (data.system) messages.push({ role: "system", content: data.system });
    messages.push({ role: "user", content: data.prompt });

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        temperature: data.temperature ?? 0.4,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      if (res.status === 429) {
        return { text: "", error: "RATE_LIMITED", message: "AI is rate-limited. Please retry shortly.", fallback: true } as const;
      }
      if (res.status === 402) {
        return { text: "", error: "AI_CREDITS_EXHAUSTED", message: "AI credits exhausted. Top up in Settings → Plans & credits.", fallback: true } as const;
      }
      return { text: "", error: "AI_GATEWAY_ERROR", message: `AI gateway ${res.status}: ${txt.slice(0, 200)}`, fallback: true } as const;
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    return { text };

  });
