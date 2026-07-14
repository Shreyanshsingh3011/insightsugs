// Lazy embedding backfill for a sheet. Extracted from
// copilot-agent.functions.ts to keep that file focused on the agent loop and
// to avoid sibling-scope references in the server-fn split transform.

import { mergeRow, stringifyRow } from "./copilot-helpers.server";

// Resumable: pass a batchCap to bound wall-time per invocation. Subsequent
// calls (from copilot questions or the backfill hook) pick up where this
// one left off, so a huge sheet reaches 100% coverage across a few runs
// instead of stalling in one request.
export async function ensureSheetEmbeddings(
  supabase: any,
  registryId: string,
  opts?: { batchCap?: number },
): Promise<{ embedded: number; total: number; remaining: number; refreshed: number }> {
  const { embedTexts, contentHash } = await import("./embeddings.server");
  const batchCap = opts?.batchCap ?? 2000;

  const { count: totalCount } = await supabase
    .from("sheet_rows")
    .select("row_index", { count: "exact", head: true })
    .eq("sheet_registry_id", registryId);
  const total = totalCount ?? 0;
  if (total === 0) return { embedded: 0, total: 0, remaining: 0, refreshed: 0 };

  // Pull existing (row_index, content_hash) so we can detect changed rows too.
  const existing = new Map<number, string>();
  {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from("sheet_row_embeddings")
        .select("row_index, content_hash")
        .eq("sheet_registry_id", registryId)
        .order("row_index", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      for (const r of data as any[]) existing.set(r.row_index, r.content_hash);
      if (data.length < PAGE) break;
    }
  }

  // Walk sheet_rows, keep track of missing OR content-changed rows.
  const needsWork: Array<{ row_index: number; data: Record<string, unknown> }> = [];
  const liveIndexes = new Set<number>();
  const PAGE = 1000;
  for (let offset = 0; needsWork.length < batchCap; offset += PAGE) {
    const { data, error } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", registryId)
      .order("row_index", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      liveIndexes.add(r.row_index);
      const merged = mergeRow(r);
      const snippet = stringifyRow(merged);
      const hash = contentHash(snippet);
      const prev = existing.get(r.row_index);
      if (prev !== hash) {
        needsWork.push({ row_index: r.row_index, data: merged });
        if (needsWork.length >= batchCap) break;
      }
    }
    if (data.length < PAGE) break;
  }

  // Prune stale embeddings for rows that no longer exist in sheet_rows.
  const stale: number[] = [];
  for (const idx of existing.keys()) if (!liveIndexes.has(idx)) stale.push(idx);
  if (stale.length) {
    const CHUNK = 500;
    for (let i = 0; i < stale.length; i += CHUNK) {
      await supabase
        .from("sheet_row_embeddings")
        .delete()
        .eq("sheet_registry_id", registryId)
        .in("row_index", stale.slice(i, i + CHUNK));
    }
  }

  if (needsWork.length === 0) {
    return { embedded: 0, total, remaining: 0, refreshed: stale.length };
  }

  const snippets = needsWork.map((r) => stringifyRow(r.data));
  const vectors = await embedTexts(snippets);
  const toUpsert = needsWork.map((r, i) => ({
    sheet_registry_id: registryId,
    row_index: r.row_index,
    content_snippet: snippets[i].slice(0, 2000),
    content_hash: contentHash(snippets[i]),
    embedding: vectors[i] as any,
  }));
  // Small batches keep pgvector HNSW index maintenance per statement short,
  // which avoids the multi-second upsert stalls seen with larger chunks.
  const CHUNK = 25;
  for (let i = 0; i < toUpsert.length; i += CHUNK) {
    const { error } = await supabase
      .from("sheet_row_embeddings")
      .upsert(toUpsert.slice(i, i + CHUNK), {
        onConflict: "sheet_registry_id,row_index",
      });
    if (error) throw new Error(`Embed upsert failed: ${error.message}`);
    // Yield between batches so concurrent row writes aren't starved by
    // back-to-back HNSW index updates.
    if (i + CHUNK < toUpsert.length) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  // Rough "remaining" — anything past this batch that still differs will be
  // picked up on the next call (backfill hook or next chat question).
  const remaining = Math.max(total - (existing.size - stale.length) - needsWork.length, 0);
  return { embedded: needsWork.length, total, remaining, refreshed: stale.length };
}
