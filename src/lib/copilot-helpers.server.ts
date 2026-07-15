// Shared helpers for the copilot agent. Extracted from
// copilot-agent.functions.ts so that the createServerFn handler in that
// module does not reference sibling module-scope declarations — which the
// server-fn split transform is known to drop, causing runtime ReferenceError
// (see tanstack-serverfn-splitting knowledge).

import { isTransientDataApiError } from "./transient-errors";

export function mergeRow(row: { canonical?: unknown; extras?: unknown }): Record<string, unknown> {
  return {
    ...(((row.canonical as Record<string, unknown>) ?? {})),
    ...(((row.extras as Record<string, unknown>) ?? {})),
  };
}

export function stringifyRow(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "") continue;
    parts.push(`${k}: ${String(v).slice(0, 200)}`);
  }
  return parts.join(" | ").slice(0, 1200);
}

export function normalizeCitationLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

export function parseCitationRowSpec(spec: string): number[] | null {
  const clean = spec.trim();
  if (/^\d+$/.test(clean)) return [Number(clean)];

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(clean);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 200) {
      return null;
    }
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }

  if (/^\d+(?:\s*,\s*\d+)+$/.test(clean)) {
    return clean.split(/\s*,\s*/).map((part) => Number(part));
  }

  return null;
}

export function isAiBillingOrQuotaError(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; message?: string; cause?: unknown };
  const status = err?.statusCode ?? err?.status;
  const message = `${err?.message ?? String(error ?? "")} ${(err?.cause as any)?.message ?? ""}`.toLowerCase();
  return (
    status === 402 ||
    status === 429 ||
    message.includes("payment required") ||
    message.includes("credits exhausted") ||
    message.includes("quota") ||
    message.includes("rate limit")
  );
}

// Cap high enough to cover the largest sheets we ingest (stock/store
// summaries ~50k rows). Copilot's deterministic + keyword tools scan the
// full row set, so a truncated cap = silently missing answers on big sheets.
export async function fetchAllRows(
  supabase: any,
  registryId: string,
  cap = 200000,
): Promise<Array<{ row_index: number; data: Record<string, unknown> }>> {
  const PAGE = 1000;
  const out: Array<{ row_index: number; data: Record<string, unknown> }> = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    let data: any[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await supabase
        .from("sheet_rows")
        .select("row_index, canonical, extras")
        .eq("sheet_registry_id", registryId)
        .order("row_index", { ascending: true })
        .range(offset, Math.min(offset + PAGE - 1, cap - 1));
      if (!result.error) {
        data = result.data ?? [];
        lastError = null;
        break;
      }
      lastError = result.error;
      if (!isTransientDataApiError(result.error) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (lastError) throw new Error((lastError as any)?.message ?? String(lastError));
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({ row_index: r.row_index, data: mergeRow(r) });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

export async function fetchAllDocumentChunks(
  supabase: any,
  documentIds: string[],
  cap = 50000,
): Promise<Array<{ document_id: string; page_no: number | null; content: string | null }>> {
  if (documentIds.length === 0) return [];
  const PAGE = 1000;
  const out: Array<{ document_id: string; page_no: number | null; content: string | null }> = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    let data: any[] | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await supabase
        .from("document_chunks")
        .select("document_id, page_no, content")
        .in("document_id", documentIds)
        .order("document_id", { ascending: true })
        .order("page_no", { ascending: true })
        .range(offset, Math.min(offset + PAGE - 1, cap - 1));
      if (!result.error) {
        data = result.data ?? [];
        lastError = null;
        break;
      }
      lastError = result.error;
      if (!isTransientDataApiError(result.error) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (lastError) throw new Error((lastError as any)?.message ?? String(lastError));
    if (!data || data.length === 0) break;
    for (const chunk of data as any[]) {
      out.push({
        document_id: chunk.document_id,
        page_no: chunk.page_no ?? null,
        content: chunk.content ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
