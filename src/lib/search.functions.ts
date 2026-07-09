import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { embedTexts as embedDocQuery, toPgVector } from "./documents.server";
import { embedQuery as embedSheetQuery } from "./embeddings.server";

export type SearchKind = "document" | "sheet" | "activity";
export type SearchSort = "relevance" | "newest";

export const ACTIVITY_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "overdue",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const DOCUMENT_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export type SearchHit = {
  kind: SearchKind;
  title: string;
  snippet: string;
  similarity: number;
  href: string;
  meta?: string;
  createdAt?: string | null;
  status?: string | null;
};

export type SearchFilters = {
  query: string;
  kinds?: SearchKind[];
  dateFrom?: string;
  dateTo?: string;
  sort?: SearchSort;
  page?: number;
  pageSize?: number;
  activityStatuses?: ActivityStatus[];
  documentStatuses?: DocumentStatus[];
};

export type SearchResult = {
  hits: SearchHit[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCandidates: number;
};

const MAX_CANDIDATES = 120;

export const semanticSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: SearchFilters) => d)
  .handler(async ({ data, context }): Promise<SearchResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const q = (data.query ?? "").trim().slice(0, 500);
    const page = Math.max(1, Math.floor(data.page ?? 1));
    const pageSize = Math.min(50, Math.max(5, Math.floor(data.pageSize ?? 10)));
    const sort: SearchSort = data.sort === "newest" ? "newest" : "relevance";
    const emptyResult: SearchResult = {
      hits: [],
      page,
      pageSize,
      hasMore: false,
      totalCandidates: 0,
    };
    if (!q) return emptyResult;

    const allKinds: SearchKind[] = ["document", "sheet", "activity"];
    const kinds = (data.kinds && data.kinds.length > 0 ? data.kinds : allKinds).filter((k) =>
      allKinds.includes(k),
    );
    const wants = (k: SearchKind) => kinds.includes(k);

    // Pull a candidate pool big enough for the current page + hasMore probe.
    const candidateCount = Math.min(MAX_CANDIDATES, pageSize * page + pageSize);
    const perSourceCount = Math.min(50, Math.max(candidateCount, 20));

    const dateFrom = data.dateFrom ? new Date(data.dateFrom) : null;
    const dateToRaw = data.dateTo ? new Date(data.dateTo) : null;
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
    const needsMeta = hasDateFilter || sort === "newest";

    // Doc chunks are stored at 768d (google/gemini-embedding-001), sheet rows
    // at 1536d (openai/text-embedding-3-small). Embed the query per source or
    // pgvector's <=> throws on dimension mismatch.
    const [docVecArr, sheetVec] = await Promise.all([
      wants("document") ? embedDocQuery([q]) : Promise.resolve([[] as number[]]),
      wants("sheet") ? embedSheetQuery(q) : Promise.resolve([] as number[]),
    ]);
    const docQStr = wants("document") ? toPgVector(docVecArr[0]) : null;
    const sheetQStr = wants("sheet") ? toPgVector(sheetVec) : null;

    const [docsRes, sheetsRes] = await Promise.all([
      wants("document")
        ? supabase.rpc("match_doc_chunks", {
            _user_id: userId,
            _query: docQStr,
            _scope_folder: null,
            _scope_document: null,
            _match_count: perSourceCount,
          })
        : Promise.resolve({ data: [] }),
      wants("sheet")
        ? supabase.rpc("match_all_sheet_rows", {
            _user_id: userId,
            _query: sheetQStr,
            _match_count: perSourceCount,
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
        .select("id, title, description, status, due_date, created_at, project_id")
        .or(`title.ilike.${like},description.ilike.${like}`)
        .limit(perSourceCount);
      if (data.activityStatuses && data.activityStatuses.length > 0) {
        query = query.in("status", data.activityStatuses);
      }
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
            createdAt: a.created_at,
            status: a.status,
          },
        });
      }
    }

    // Fetch created_at + status metadata for docs and sheets when needed.
    if (needsMeta || (data.documentStatuses && data.documentStatuses.length > 0)) {
      const docIds = Array.from(new Set(docPending.map((p) => p.id)));
      const sheetIds = Array.from(new Set(sheetPending.map((p) => p.id)));
      const [docMeta, sheetMeta] = await Promise.all([
        docIds.length
          ? supabase.from("documents").select("id, created_at, status").in("id", docIds)
          : Promise.resolve({ data: [] }),
        sheetIds.length
          ? supabase.from("sheet_registry").select("id, created_at").in("id", sheetIds)
          : Promise.resolve({ data: [] }),
      ]);
      const dMap = new Map<string, { created_at: string; status: string }>();
      for (const r of (docMeta.data ?? []) as any[])
        dMap.set(r.id, { created_at: r.created_at, status: r.status });
      const sMap = new Map<string, string>();
      for (const r of (sheetMeta.data ?? []) as any[]) sMap.set(r.id, r.created_at);
      for (const p of docPending) {
        const m = dMap.get(p.id);
        p.hit.createdAt = m?.created_at ?? null;
        p.hit.status = m?.status ?? null;
      }
      for (const p of sheetPending) {
        p.hit.createdAt = sMap.get(p.id) ?? null;
      }
    }

    let all: SearchHit[] = [
      ...docPending.map((p) => p.hit),
      ...sheetPending.map((p) => p.hit),
      ...actPending.map((p) => p.hit),
    ];

    // Apply post-filters.
    if (hasDateFilter) {
      all = all.filter((h) => (h.kind === "activity" ? true : inRange(h.createdAt)));
    }
    if (data.documentStatuses && data.documentStatuses.length > 0) {
      const set = new Set<string>(data.documentStatuses);
      all = all.filter((h) => (h.kind === "document" ? !!h.status && set.has(h.status) : true));
    }

    // Sort.
    if (sort === "newest") {
      all.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });
    } else {
      all.sort((a, b) => b.similarity - a.similarity);
    }

    const totalCandidates = all.length;
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const hits = all.slice(start, end);
    const hasMore = totalCandidates > end;

    return { hits, page, pageSize, hasMore, totalCandidates };
  });
