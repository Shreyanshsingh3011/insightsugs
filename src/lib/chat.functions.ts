import { createServerFn } from "@tanstack/react-start";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway";

export const askChatbot = createServerFn({ method: "POST" })
  .inputValidator((d: { question: string; dataJson: string; history: { role: "user" | "assistant"; content: string }[] }) => d)
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY missing");
    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const system = `You are a strict data-bound assistant for a project-delay analytics dashboard.
RULES:
- Answer ONLY using facts present in the JSON DATA below.
- If the answer is not derivable from the data, reply: "I don't have that in the current dashboard data."
- Be concise. Use bullet points and small tables when helpful. Cite numbers exactly.
- Do not speculate, do not invent names, departments, or activities.

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
    return { answer: text };
  });
