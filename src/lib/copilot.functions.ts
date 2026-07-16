import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedTexts, toPgVector } from "./documents.server";

export type CopilotMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: { document_id: string; document_name: string; page_no: number | null; snippet: string }[];
  scope: { folder_id?: string | null; document_id?: string | null };
  created_at: string;
};

export const listCopilotMessages = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context as { supabase: any };
    const { data, error } = await supabase
      .from("copilot_messages")
      .select("id,role,content,citations,scope,created_at")
      .order("created_at", { ascending: true })
      .limit(200);
    if (error) throw new Error(error.message);
    return { messages: (data ?? []) as CopilotMessage[] };
  });

export const clearCopilotConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { error } = await supabase
      .from("copilot_messages")
      .delete()
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const sendCopilotMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      question: string;
      scope_folder_id?: string | null;
      scope_document_id?: string | null;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const key = process.env.LOVABLE_API_KEY!;
    const question = data.question.trim().slice(0, 2000);
    if (!question) throw new Error("Empty question");

    // 1) save user message
    await supabase.from("copilot_messages").insert({
      user_id: userId,
      role: "user",
      content: question,
      citations: [],
      scope: {
        folder_id: data.scope_folder_id ?? null,
        document_id: data.scope_document_id ?? null,
      },
    });

    // 2) embed query
    const [qVec] = await embedTexts([question]);

    // 3) retrieve top-K chunks via RPC (scoped by caller's auth.uid())
    const { data: matches, error: mErr } = await supabase.rpc("match_doc_chunks", {
      _user_id: userId,
      _query: toPgVector(qVec),
      _scope_folder: data.scope_folder_id ?? null,
      _scope_document: data.scope_document_id ?? null,
      _match_count: 6,
    });
    if (mErr) throw new Error(mErr.message);

    const ctxRows = (matches ?? []) as {
      chunk_id: string;
      document_id: string;
      document_name: string;
      page_no: number | null;
      content: string;
      similarity: number;
    }[];

    let answer: string;
    let citations: CopilotMessage["citations"] = [];

    if (ctxRows.length === 0) {
      answer =
        "I couldn't find anything related to that in the documents you have access to. Try uploading a relevant file or widening the scope.";
    } else {
      const ctxBlock = ctxRows
        .map(
          (r, i) =>
            `[${i + 1}] ${r.document_name}${r.page_no ? ` (p.${r.page_no})` : ""}\n${r.content}`,
        )
        .join("\n\n---\n\n");

      const system =
        "You are a document-grounded assistant. Answer ONLY using the provided context. " +
        "If the answer isn't in the context, say you don't know. " +
        "Cite sources inline as [n] matching the numbered context blocks. " +
        "Be concise. Use markdown when helpful.";

      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": key,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: `CONTEXT:\n${ctxBlock}\n\nQUESTION: ${question}`,
            },
          ],
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`AI error (${res.status}): ${t.slice(0, 200)}`);
      }
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      answer = j.choices?.[0]?.message?.content?.trim() ?? "(empty response)";
      citations = ctxRows.map((r) => ({
        document_id: r.document_id,
        document_name: r.document_name,
        page_no: r.page_no,
        snippet: r.content.slice(0, 240),
      }));
    }

    const { data: saved, error: sErr } = await supabase
      .from("copilot_messages")
      .insert({
        user_id: userId,
        role: "assistant",
        content: answer,
        citations,
        scope: {
          folder_id: data.scope_folder_id ?? null,
          document_id: data.scope_document_id ?? null,
        },
      })
      .select("id,role,content,citations,scope,created_at")
      .single();
    if (sErr) throw new Error(sErr.message);

    return { message: saved as CopilotMessage };
  });
