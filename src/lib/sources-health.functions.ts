import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SheetHealth = {
  id: string;
  display_name: string;
  sheet_type: string | null;
  row_count: number | null;
  last_refreshed_at: string | null;
  hours_since_sync: number | null;
  degraded_until: string | null;
  last_error: string | null;
  status: "fresh" | "stale" | "degraded" | "error" | "never-synced";
};

export type DocumentHealth = {
  id: string;
  name: string;
  status: string | null;
  status_error: string | null;
  page_count: number | null;
  chunk_count: number;
  has_embeddings: boolean;
  created_at: string;
  health: "ok" | "no-chunks" | "missing-embeddings" | "error";
};

export type SourcesHealthReport = {
  generated_at: string;
  sheets: SheetHealth[];
  documents: DocumentHealth[];
  summary: {
    sheets_total: number;
    sheets_healthy: number;
    sheets_stale: number;
    sheets_broken: number;
    documents_total: number;
    documents_missing_embeddings: number;
    documents_errored: number;
  };
};

const STALE_HOURS = 6;

export const getSourcesHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<SourcesHealthReport> => {
    const { supabase } = context;
    const now = Date.now();

    const { data: sheetsRaw, error: sheetsErr } = await supabase
      .from("sheet_registry")
      .select("id, display_name, sheet_type, row_count, last_refreshed_at, degraded_until, last_error")
      .order("display_name", { ascending: true });
    if (sheetsErr) throw new Error(`sheet_registry: ${sheetsErr.message}`);

    const sheets: SheetHealth[] = (sheetsRaw ?? []).map((s) => {
      const last = s.last_refreshed_at ? new Date(s.last_refreshed_at).getTime() : null;
      const hours = last ? (now - last) / 3_600_000 : null;
      const degradedActive = s.degraded_until && new Date(s.degraded_until).getTime() > now;
      let status: SheetHealth["status"] = "fresh";
      if (!last) status = "never-synced";
      else if (degradedActive || s.last_error) status = "error";
      else if (hours !== null && hours > STALE_HOURS) status = "stale";
      return {
        id: s.id,
        display_name: s.display_name,
        sheet_type: s.sheet_type,
        row_count: s.row_count,
        last_refreshed_at: s.last_refreshed_at,
        hours_since_sync: hours === null ? null : Math.round(hours * 10) / 10,
        degraded_until: s.degraded_until,
        last_error: s.last_error,
        status,
      };
    });

    const { data: docsRaw, error: docsErr } = await supabase
      .from("documents")
      .select("id, name, status, status_error, page_count, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (docsErr) throw new Error(`documents: ${docsErr.message}`);

    const docIds = (docsRaw ?? []).map((d) => d.id);
    const chunkCounts = new Map<string, { total: number; withEmb: number }>();
    if (docIds.length > 0) {
      const { data: chunks } = await supabase
        .from("document_chunks")
        .select("document_id, embedding")
        .in("document_id", docIds);
      for (const c of chunks ?? []) {
        const cur = chunkCounts.get(c.document_id) ?? { total: 0, withEmb: 0 };
        cur.total += 1;
        if (c.embedding) cur.withEmb += 1;
        chunkCounts.set(c.document_id, cur);
      }
    }

    const documents: DocumentHealth[] = (docsRaw ?? []).map((d) => {
      const c = chunkCounts.get(d.id) ?? { total: 0, withEmb: 0 };
      let health: DocumentHealth["health"] = "ok";
      if (d.status_error || d.status === "failed") health = "error";
      else if (c.total === 0) health = "no-chunks";
      else if (c.withEmb < c.total) health = "missing-embeddings";
      return {
        id: d.id,
        name: d.name,
        status: d.status,
        status_error: d.status_error,
        page_count: d.page_count,
        chunk_count: c.total,
        has_embeddings: c.total > 0 && c.withEmb === c.total,
        created_at: d.created_at,
        health,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      sheets,
      documents,
      summary: {
        sheets_total: sheets.length,
        sheets_healthy: sheets.filter((s) => s.status === "fresh").length,
        sheets_stale: sheets.filter((s) => s.status === "stale").length,
        sheets_broken: sheets.filter((s) => s.status === "error" || s.status === "never-synced").length,
        documents_total: documents.length,
        documents_missing_embeddings: documents.filter((d) => d.health === "missing-embeddings" || d.health === "no-chunks").length,
        documents_errored: documents.filter((d) => d.health === "error").length,
      },
    };
  });
