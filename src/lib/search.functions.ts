import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedTexts, toPgVector } from "./documents.server";

export type SearchHit = {
  kind: "document" | "sheet" | "activity";
  title: string;
  snippet: string;
  similarity: number;
  href: string;
  meta?: string;
};

export const semanticSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query: string; limit?: number }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const q = (data.query ?? "").trim().slice(0, 500);
    if (!q) return { hits: [] as SearchHit[] };
    const limit = Math.min(Math.max(data.limit ?? 8, 3), 20);

    const [qVec] = await embedTexts([q]);
    const qStr = toPgVector(qVec);

    const [docsRes, sheetsRes] = await Promise.all([
      supabase.rpc("match_doc_chunks", {
        _user_id: userId,
        _query: qStr,
        _scope_folder: null,
        _scope_document: null,
        _match_count: limit,
      }),
      supabase.rpc("match_all_sheet_rows", {
        _user_id: userId,
        _query: qStr,
        _match_count: limit,
      }),
    ]);

    const hits: SearchHit[] = [];
    for (const r of (docsRes.data ?? []) as any[]) {
      hits.push({
        kind: "document",
        title: r.document_name,
        snippet: String(r.content ?? "").slice(0, 400),
        similarity: Number(r.similarity ?? 0),
        href: `/documents?doc=${r.document_id}`,
        meta: r.page_no ? `Page ${r.page_no}` : undefined,
      });
    }
    for (const r of (sheetsRes.data ?? []) as any[]) {
      hits.push({
        kind: "sheet",
        title: r.sheet_name,
        snippet: String(r.snippet ?? "").slice(0, 400),
        similarity: Number(r.similarity ?? 0),
        href: `/sheets/${r.sheet_registry_id}?highlight=${r.row_index}`,
        meta: `Row ${r.row_index}`,
      });
    }

    // Activities: keyword ILIKE across title/description (RLS-scoped).
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const { data: acts } = await supabase
      .from("activities")
      .select("id, title, description, status, due_date, project_id")
      .or(`title.ilike.${like},description.ilike.${like}`)
      .limit(limit);
    for (const a of (acts ?? []) as any[]) {
      const desc = String(a.description ?? "");
      hits.push({
        kind: "activity",
        title: a.title,
        snippet: desc.slice(0, 400) || `Status: ${a.status}${a.due_date ? ` · Due ${a.due_date}` : ""}`,
        similarity: 0.5,
        href: `/my-activities`,
        meta: a.due_date ? `Due ${a.due_date}` : a.status,
      });
    }

    hits.sort((a, b) => b.similarity - a.similarity);
    return { hits: hits.slice(0, limit * 2) };
  });
