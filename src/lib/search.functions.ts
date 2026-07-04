import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedTexts, toPgVector } from "./documents.server";

export type SearchKind = "document" | "sheet" | "activity";

export type SearchHit = {
  kind: SearchKind;
  title: string;
  snippet: string;
  similarity: number;
  href: string;
  meta?: string;
};

export type SearchFilters = {
  query: string;
  limit?: number;
  kinds?: SearchKind[];
  dateFrom?: string; // ISO date (yyyy-mm-dd)
  dateTo?: string; // ISO date (yyyy-mm-dd, inclusive)
};

export const semanticSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: SearchFilters) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const q = (data.query ?? "").trim().slice(0, 500);
    if (!q) return { hits: [] as SearchHit[] };
    const limit = Math.min(Math.max(data.limit ?? 8, 3), 20);
    const allKinds: SearchKind[] = ["document", "sheet", "activity"];
    const kinds = (data.kinds && data.kinds.length > 0 ? data.kinds : allKinds).filter((k) =>
      allKinds.includes(k),
    );
    const wants = (k: SearchKind) => kinds.includes(k);

    const dateFrom = data.dateFrom ? new Date(data.dateFrom) : null;
    const dateToRaw = data.dateTo ? new Date(data.dateTo) : null;
    // Make dateTo inclusive through end-of-day.
    const dateTo = dateToRaw ? new Date(dateToRaw.getTime() + 24 * 60 * 60 * 1000 - 1) : null;
    const hasDateFilter = !!(dateFrom || dateTo);
    const inRange = (iso: string | null | undefined) => {
      if (!hasDateFilter) return true;
      if (!iso) return false;
      const t = new Date(iso).getTime();
      if (dateFrom && t < dateFrom.getTime()) return false;
      if (dateTo && t > dateTo.getTime()) return false;
      return true;
    };

    const [qVec] = await embedTexts([q]);
    const qStr = toPgVector(qVec);

    const [docsRes, sheetsRes] = await Promise.all([
      wants("document")
        ? supabase.rpc("match_doc_chunks", {
            _user_id: userId,
            _query: qStr,
            _scope_folder: null,
            _scope_document: null,
            _match_count: limit,
          })
        : Promise.resolve({ data: [] }),
      wants("sheet")
        ? supabase.rpc("match_all_sheet_rows", {
            _user_id: userId,
            _query: qStr,
            _match_count: limit,
          })
        : Promise.resolve({ data: [] }),
    ]);

    type Pending = { hit: SearchHit; id: string };
    const docPending: Pending[] = [];
    const sheetPending: Pending[] = [];
    const actPending: Pending[] = [];

    for (const r of (docsRes.data ?? []) as any[]) {
      docPending.push({
        id: r.document_id,
        hit: {
          kind: "document",
          title: r.document_name,
          snippet: String(r.content ?? "").slice(0, 400),
          similarity: Number(r.similarity ?? 0),
          href: `/documents?doc=${r.document_id}`,
          meta: r.page_no ? `Page ${r.page_no}` : undefined,
        },
      });
    }
    for (const r of (sheetsRes.data ?? []) as any[]) {
      sheetPending.push({
        id: r.sheet_registry_id,
        hit: {
          kind: "sheet",
          title: r.sheet_name,
          snippet: String(r.snippet ?? "").slice(0, 400),
          similarity: Number(r.similarity ?? 0),
          href: `/sheets/${r.sheet_registry_id}?highlight=${r.row_index}`,
          meta: `Row ${r.row_index}`,
        },
      });
    }

    if (wants("activity")) {
      const like = `%${q.replace(/[%_]/g, "")}%`;
      let query = supabase
        .from("activities")
        .select("id, title, description, status, due_date, created_at, updated_at, project_id")
        .or(`title.ilike.${like},description.ilike.${like}`)
        .limit(limit);
      if (data.dateFrom) query = query.gte("created_at", data.dateFrom);
      if (data.dateTo) {
        const end = new Date(new Date(data.dateTo).getTime() + 24 * 60 * 60 * 1000).toISOString();
        query = query.lt("created_at", end);
      }
      const { data: acts } = await query;
      for (const a of (acts ?? []) as any[]) {
        const desc = String(a.description ?? "");
        actPending.push({
          id: a.id,
          hit: {
            kind: "activity",
            title: a.title,
            snippet:
              desc.slice(0, 400) ||
              `Status: ${a.status}${a.due_date ? ` · Due ${a.due_date}` : ""}`,
            similarity: 0.5,
            href: `/my-activities`,
            meta: a.due_date ? `Due ${a.due_date}` : a.status,
          },
        });
      }
    }

    // Fetch created_at metadata for doc/sheet hits when a date filter is active.
    if (hasDateFilter && (docPending.length || sheetPending.length)) {
      const docIds = Array.from(new Set(docPending.map((p) => p.id)));
      const sheetIds = Array.from(new Set(sheetPending.map((p) => p.id)));
      const [docMeta, sheetMeta] = await Promise.all([
        docIds.length
          ? supabase.from("documents").select("id, created_at").in("id", docIds)
          : Promise.resolve({ data: [] }),
        sheetIds.length
          ? supabase.from("sheet_registry").select("id, created_at").in("id", sheetIds)
          : Promise.resolve({ data: [] }),
      ]);
      const dMap = new Map<string, string>();
      for (const r of (docMeta.data ?? []) as any[]) dMap.set(r.id, r.created_at);
      const sMap = new Map<string, string>();
      for (const r of (sheetMeta.data ?? []) as any[]) sMap.set(r.id, r.created_at);

      const keptDocs = docPending.filter((p) => inRange(dMap.get(p.id)));
      const keptSheets = sheetPending.filter((p) => inRange(sMap.get(p.id)));
      const hits = [
        ...keptDocs.map((p) => p.hit),
        ...keptSheets.map((p) => p.hit),
        ...actPending.map((p) => p.hit),
      ];
      hits.sort((a, b) => b.similarity - a.similarity);
      return { hits: hits.slice(0, limit * 2) };
    }

    const hits = [
      ...docPending.map((p) => p.hit),
      ...sheetPending.map((p) => p.hit),
      ...actPending.map((p) => p.hit),
    ];
    hits.sort((a, b) => b.similarity - a.similarity);
    return { hits: hits.slice(0, limit * 2) };
  });
