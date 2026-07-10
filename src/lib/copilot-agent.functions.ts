// Agentic Copilot: the model plans and calls tools that read your sheets/docs.
// The model NEVER sees raw rows in its system prompt; every fact it can cite
// must come from a tool it explicitly called this turn. See plan for the
// full contract.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
// Heavy AI SDK + gateway modules are lazy-loaded inside the handler to keep
// them out of the SSR entry bundle.


// -------------------- helpers --------------------

function mergeRow(row: { canonical?: unknown; extras?: unknown }): Record<string, unknown> {
  return {
    ...(((row.canonical as Record<string, unknown>) ?? {})),
    ...(((row.extras as Record<string, unknown>) ?? {})),
  };
}

function stringifyRow(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null || v === "") continue;
    parts.push(`${k}: ${String(v).slice(0, 200)}`);
  }
  return parts.join(" | ").slice(0, 1200);
}

function normalizeCitationLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCitationRowSpec(spec: string): number[] | null {
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

function isAiBillingOrQuotaError(error: unknown): boolean {
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

async function fetchAllRows(
  supabase: any,
  registryId: string,
  cap = 20000,
): Promise<Array<{ row_index: number; data: Record<string, unknown> }>> {
  const PAGE = 1000;
  const out: Array<{ row_index: number; data: Record<string, unknown> }> = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const { data, error } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", registryId)
      .order("row_index", { ascending: true })
      .range(offset, Math.min(offset + PAGE - 1, cap - 1));
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({ row_index: r.row_index, data: mergeRow(r) });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// Lazily embed rows for a sheet that don't yet have an embedding row.
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

// -------------------- ledger --------------------

type LedgerEntry =
  | { kind: "sheet_row"; registryId: string; sheetLabel: string; rowIndex: number; data: Record<string, unknown> }
  | { kind: "doc_chunk"; documentId: string; documentName: string; pageNo: number; snippet: string };

// Kept intentionally `any`-shaped: TanStack Start's server-fn return type
// checker rejects `unknown` (not JSON-serializable by its rule set).
type ToolCallLog = {
  name: string;
  args: any;
  ok: boolean;
  ms: number;
  summary: string;
  result?: any;
};

// -------------------- main server function --------------------

const InputSchema = z
  .object({
    question: z.string().min(1).max(2000),
    sheetIds: z.array(z.string().uuid()).max(10).default([]),
    documentIds: z.array(z.string().uuid()).max(10).default([]),
    history: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().max(8000),
        }),
      )
      .max(20)
      .default([]),
  })
  .refine((v) => v.sheetIds.length + v.documentIds.length > 0, {
    message: "Select at least one sheet or document.",
  });

// Core handler body extracted so other server-fn handlers (auto-insights,
// document auto-insights, etc.) can invoke it in-process instead of going
// through the client RPC stub — the stub path fails with
// "Server function info not found for <hash>" when the callee isn't in the
// client manifest.
export async function runCopilotAgent(
  data: z.infer<typeof InputSchema>,
  context: { supabase: any; userId: string },
  opts: { skipCitationEnforcement?: boolean } = {},
) {



    const { supabase, userId } = context;
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    // Lazy-load heavy AI SDK + gateway to keep SSR bundle slim.
    const [
      { generateText, stepCountIs, tool },
      { createLovableAiGatewayProvider },
    ] = await Promise.all([
      import("ai"),
      import("@/lib/ai-gateway"),
    ]);



    // 1) Resolve sheet + document metadata (labels for citations, IDs for scope).
    const [regsRes, docsRes] = await Promise.all([
      data.sheetIds.length
        ? supabase
            .from("sheet_registry")
            .select("id, display_name, sheet_type, row_count")
            .in("id", data.sheetIds)
        : Promise.resolve({ data: [] as any[], error: null }),

      data.documentIds.length
        ? supabase
            .from("documents")
            .select("id, name, summary, page_count")
            .in("id", data.documentIds)
        : Promise.resolve({ data: [] as any[], error: null }),
    ]);
    if ((regsRes as any).error) throw new Error((regsRes as any).error.message);
    if ((docsRes as any).error) throw new Error((docsRes as any).error.message);

    const regs = (regsRes.data ?? []) as {
      id: string;
      display_name: string;
      sheet_type: string;
      row_count: number | null;
    }[];
    const docs = (docsRes.data ?? []) as {
      id: string;
      name: string;
      summary: string | null;
      page_count: number | null;
    }[];


    // SCOPE GUARD: if none of the requested sheet/doc IDs resolved to real
    // records the user can access, refuse immediately. Never fall back to
    // dashboard aggregates, cached rows, or any other data source.
    if (regs.length === 0 && docs.length === 0) {
      return {
        answer:
          "No sheet or document is selected for this turn. Select a sheet or document and ask again — I only read from what you explicitly select, never from dashboard-level cached data.",
        sources: [],
        suggestions: [],
        toolTrace: [],
        citationOk: true,
        scope: { sheetIds: data.sheetIds, documentIds: data.documentIds },
      };
    }

    const sheetById = new Map(regs.map((r) => [r.id, r]));
    const sheetByLabel = new Map(regs.map((r) => [normalizeCitationLabel(r.display_name), r]));
    const docById = new Map(docs.map((d) => [d.id, d]));
    const docByLabel = new Map(docs.map((d) => [normalizeCitationLabel(d.name), d]));


    // 2) Ledger — every row/chunk the model was given via a tool call.
    const ledger: LedgerEntry[] = [];
    const toolTrace: ToolCallLog[] = [];
    const cachedRowsBySheet = new Map<
      string,
      Array<{ row_index: number; data: Record<string, unknown> }>
    >();

    const getSheetRows = async (registryId: string) => {
      const cached = cachedRowsBySheet.get(registryId);
      if (cached) return cached;
      const rows = await fetchAllRows(supabase, registryId);
      cachedRowsBySheet.set(registryId, rows);
      return rows;
    };

    // 3) Tools — each records to the ledger and toolTrace.

    const withTrace = async <T>(name: string, args: unknown, fn: () => Promise<T>) => {
      const started = performance.now();
      try {
        const result = (await fn()) as any;
        toolTrace.push({
          name,
          args,
          ok: true,
          ms: Math.round(performance.now() - started),
          summary: result?._summary ?? "ok",
          result: result?._resultForModel ?? result,
        });
        return result?._resultForModel ?? result;
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        toolTrace.push({
          name,
          args,
          ok: false,
          ms: Math.round(performance.now() - started),
          summary: msg.slice(0, 200),
        });
        return { error: msg };
      }
    };

    const searchSheetRows = tool({
      description:
        "Semantic + keyword search for rows in a specific sheet. Returns up to k rows most relevant to the query.",
      inputSchema: z.object({
        sheet_id: z.string().uuid().describe("Sheet registry id from the sheets catalog"),
        query: z.string().min(1).max(500),
        k: z.number().int().min(1).max(20).default(8),
      }),
      execute: async ({ sheet_id, query, k }) =>
        withTrace("search_sheet_rows", { sheet_id, query, k }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const byIndex = new Map(rows.map((r) => [r.row_index, r.data]));

          // Try vector search first; fall back to keyword scan if embeddings
          // are unavailable (e.g. Lovable AI credits exhausted → 402/429).
          let matches: Array<{ row_index: number; similarity?: number }> = [];
          let mode: "vector" | "keyword" = "vector";
          try {
            const { embedQuery } = await import("./embeddings.server");
            void ensureSheetEmbeddings(supabase, sheet_id, { batchCap: 200 }).catch(() => {});
            const qvec = await embedQuery(query);
            const { data, error } = await supabase.rpc("match_sheet_rows", {
              _user_id: userId,
              _registry_id: sheet_id,
              _query: qvec as any,
              _match_count: k,
            });
            if (error) throw new Error(error.message);
            matches = (data ?? []) as any;
          } catch {
            // Keyword-scan fallback: rank rows by count of query-token hits
            // across all cell values. Guarantees the model still gets rows
            // when embeddings are down, so auto-insights doesn't come back
            // empty on 402/429.
            mode = "keyword";
            const tokens = query
              .toLowerCase()
              .split(/[^a-z0-9]+/i)
              .filter((t) => t.length >= 3);
            const scored = rows.map((r) => {
              const hay = Object.values(r.data).map((v) => String(v ?? "").toLowerCase()).join(" \u0001 ");
              let score = 0;
              for (const t of tokens) if (hay.includes(t)) score++;
              return { row_index: r.row_index, similarity: score };
            });
            scored.sort((a, b) => b.similarity - a.similarity);
            const anyHit = scored.some((s) => s.similarity > 0);
            matches = (anyHit ? scored.filter((s) => s.similarity > 0) : scored).slice(0, k);
          }

          const results = matches.map((m: any) => {
            const dataRow = byIndex.get(m.row_index) ?? {};
            ledger.push({
              kind: "sheet_row",
              registryId: sheet_id,
              sheetLabel: reg.display_name,
              rowIndex: m.row_index,
              data: dataRow,
            });
            return {
              sheet: reg.display_name,
              row_index: m.row_index,
              similarity: Number(m.similarity?.toFixed?.(3) ?? m.similarity ?? 0),
              data: dataRow,
              cite: `[sheet:${reg.display_name} row ${m.row_index + 1}]`,
            };
          });

          return {
            _summary: `${results.length} rows from "${reg.display_name}" (${mode})`,
            _resultForModel: { sheet: reg.display_name, mode, matches: results },
          };
        }),
    });

    const filterSheetRows = tool({
      description:
        "Filter a sheet by column value. op: eq|neq|contains|gt|gte|lt|lte. Returns up to 50 matching rows.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        column: z.string().min(1).max(120),
        op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte"]),
        value: z.union([z.string(), z.number(), z.boolean()]),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async ({ sheet_id, column, op, value, limit }) =>
        withTrace("filter_sheet_rows", { sheet_id, column, op, value, limit }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const num = typeof value === "number" ? value : Number(value);
          const numeric = ["gt", "gte", "lt", "lte"].includes(op);
          const s = String(value).toLowerCase();
          const matches: Array<{ row_index: number; data: Record<string, unknown> }> = [];
          for (const r of rows) {
            const v = r.data[column];
            if (v == null) continue;
            let hit = false;
            if (numeric) {
              const nv = Number(v);
              if (!Number.isFinite(nv) || !Number.isFinite(num)) continue;
              if (op === "gt") hit = nv > num;
              else if (op === "gte") hit = nv >= num;
              else if (op === "lt") hit = nv < num;
              else if (op === "lte") hit = nv <= num;
            } else {
              const sv = String(v).toLowerCase();
              if (op === "eq") hit = sv === s;
              else if (op === "neq") hit = sv !== s;
              else if (op === "contains") hit = sv.includes(s);
            }
            if (hit) {
              matches.push(r);
              if (matches.length >= limit) break;
            }
          }
          for (const r of matches) {
            ledger.push({
              kind: "sheet_row",
              registryId: sheet_id,
              sheetLabel: reg.display_name,
              rowIndex: r.row_index,
              data: r.data,
            });
          }
          return {
            _summary: `${matches.length} rows match ${column} ${op} ${JSON.stringify(value)}`,
            _resultForModel: {
              sheet: reg.display_name,
              total_scanned: rows.length,
              rows: matches.map((r) => ({
                row_index: r.row_index,
                data: r.data,
                cite: `[sheet:${reg.display_name} row ${r.row_index + 1}]`,
              })),
            },
          };
        }),
    });

    const aggregateColumn = tool({
      description:
        "Compute an aggregate over a numeric column: sum, avg, min, max, or count. Optionally group by another column (top 20 groups).",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        column: z.string().min(1).max(120),
        op: z.enum(["sum", "avg", "min", "max", "count"]),
        group_by: z.string().min(1).max(120).nullable().default(null),
      }),
      execute: async ({ sheet_id, column, op, group_by }) =>
        withTrace("aggregate_column", { sheet_id, column, op, group_by }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const compute = (subset: typeof rows) => {
            const nums: number[] = [];
            for (const r of subset) {
              const v = r.data[column];
              if (v == null || v === "") continue;
              if (op === "count") {
                nums.push(1);
              } else {
                const n = Number(v);
                if (Number.isFinite(n)) nums.push(n);
              }
            }
            if (nums.length === 0) return null;
            if (op === "count") return nums.length;
            if (op === "sum") return nums.reduce((a, b) => a + b, 0);
            if (op === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
            if (op === "min") return Math.min(...nums);
            if (op === "max") return Math.max(...nums);
            return null;
          };

          if (!group_by) {
            const value = compute(rows);
            return {
              _summary: `${op}(${column}) = ${value}`,
              _resultForModel: {
                sheet: reg.display_name,
                op,
                column,
                value,
                row_count: rows.length,
              },
            };
          }

          const groups = new Map<string, typeof rows>();
          for (const r of rows) {
            const g = String(r.data[group_by] ?? "(blank)");
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g)!.push(r);
          }
          const rows_out = Array.from(groups.entries())
            .map(([g, subset]) => ({ group: g, value: compute(subset), n: subset.length }))
            .filter((r) => r.value != null)
            .sort((a, b) => Number(b.value) - Number(a.value))
            .slice(0, 20);
          return {
            _summary: `${op}(${column}) grouped by ${group_by}: ${rows_out.length} groups`,
            _resultForModel: { sheet: reg.display_name, op, column, group_by, rows: rows_out },
          };
        }),
    });

    const getSheetSchema = tool({
      description:
        "List the columns present in a sheet and up to 3 sample values per column. Call this before other tools if you're unsure which column to use.",
      inputSchema: z.object({ sheet_id: z.string().uuid() }),
      execute: async ({ sheet_id }) =>
        withTrace("get_sheet_schema", { sheet_id }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const cols = new Map<string, Set<string>>();
          for (const r of rows.slice(0, 200)) {
            for (const [k, v] of Object.entries(r.data)) {
              if (v == null || v === "") continue;
              if (!cols.has(k)) cols.set(k, new Set());
              const s = cols.get(k)!;
              if (s.size < 3) s.add(String(v).slice(0, 60));
            }
          }
          const columns = Array.from(cols.entries()).map(([name, samples]) => ({
            name,
            samples: Array.from(samples),
          }));
          return {
            _summary: `${columns.length} columns`,
            _resultForModel: {
              sheet: reg.display_name,
              sheet_type: reg.sheet_type,
              total_rows: rows.length,
              columns,
            },
          };
        }),
    });

    const getRow = tool({
      description: "Fetch one exact row by row_index. Useful to double-check a citation.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        row_index: z.number().int().min(0),
      }),
      execute: async ({ sheet_id, row_index }) =>
        withTrace("get_row", { sheet_id, row_index }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const hit = rows.find((r) => r.row_index === row_index);
          if (!hit) return { error: "No such row_index" };
          ledger.push({
            kind: "sheet_row",
            registryId: sheet_id,
            sheetLabel: reg.display_name,
            rowIndex: row_index,
            data: hit.data,
          });
          return {
            _summary: `row ${row_index} from "${reg.display_name}"`,
            _resultForModel: {
              sheet: reg.display_name,
              row_index,
              data: hit.data,
              cite: `[sheet:${reg.display_name} row ${row_index + 1}]`,
            },
          };
        }),
    });

    const getCell = tool({
      description:
        "Fetch ONE exact cell value: the value at (row_index, column) in a sheet. Use this when the user's question is about a specific field of a specific record (e.g. 'phone of X', 'status of order 42', 'due date of task Y'). Prefer this over get_row when you only need one column so the citation pins the exact source cell.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        row_index: z.number().int().min(0),
        column: z.string().min(1).max(120),
      }),
      execute: async ({ sheet_id, row_index, column }) =>
        withTrace("get_cell", { sheet_id, row_index, column }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const hit = rows.find((r) => r.row_index === row_index);
          if (!hit) return { error: "No such row_index" };
          // Case-insensitive column resolution.
          const key = Object.keys(hit.data).find(
            (k) => k.toLowerCase().trim() === column.toLowerCase().trim(),
          );
          if (!key) {
            return {
              error: `Column not found. Available: ${Object.keys(hit.data).slice(0, 40).join(", ")}`,
            };
          }
          const value = hit.data[key];
          ledger.push({
            kind: "sheet_row",
            registryId: sheet_id,
            sheetLabel: reg.display_name,
            rowIndex: row_index,
            data: hit.data,
          });
          return {
            _summary: `${key} @ row ${row_index + 1} of "${reg.display_name}" = ${String(value ?? "").slice(0, 80)}`,
            _resultForModel: {
              sheet: reg.display_name,
              row_index,
              column: key,
              value,
              cite: `[sheet:${reg.display_name} row ${row_index + 1} col ${key}]`,
            },
          };
        }),
    });

    const searchDocChunks = tool({
      description:
        "Semantic search over the text of a specific document. Returns up to k page-scoped chunks.",
      inputSchema: z.object({
        document_id: z.string().uuid(),
        query: z.string().min(1).max(500),
        k: z.number().int().min(1).max(12).default(6),
      }),
      execute: async ({ document_id, query, k }) =>
        withTrace("search_doc_chunks", { document_id, query, k }, async () => {
          const doc = docById.get(document_id);
          if (!doc) return { error: "Unknown document_id" };
          // Doc chunks are stored at 768d (google/gemini-embedding-001 via
          // documents.server.embedTexts). Must query with the SAME model or
          // pgvector's <=> errors on dim mismatch and the RPC returns nothing.
          const { embedTexts: embedDocQuery } = await import("./documents.server");
          const [qvec] = await embedDocQuery([query]);
          const { data: matches, error } = await supabase.rpc("match_doc_chunks", {
            _user_id: userId,
            _query: qvec as any,
            _scope_folder: null as unknown as string,
            _scope_document: document_id,
            _match_count: k,
          });
          if (error) return { error: error.message };
          const results = (matches ?? []).map((m: any) => {
            ledger.push({
              kind: "doc_chunk",
              documentId: m.document_id,
              documentName: m.document_name,
              pageNo: m.page_no ?? 0,
              snippet: m.content ?? "",
            });
            return {
              document: m.document_name,
              page: m.page_no ?? 0,
              snippet: (m.content ?? "").slice(0, 400),
              similarity: Number(m.similarity?.toFixed?.(3) ?? 0),
              cite: `[doc:${m.document_name} p.${m.page_no ?? 0}]`,
            };
          });
          return {
            _summary: `${results.length} chunks from "${doc.name}"`,
            _resultForModel: { document: doc.name, matches: results },
          };
        }),
    });

    // ---------- ACTION TOOLS (write) ----------
    // These create pending records the user can review in Alerts / Agent Inbox / Activities.
    // Every action is scoped to the authenticated user via RLS (supabase = user client).

    const createAlert = tool({
      description:
        "Create a delay alert (status=open) for the user to review on the Alerts page. Use ONLY when the user explicitly asks to flag/raise/create an alert. Cite the supporting rows in `reason`.",
      inputSchema: z.object({
        activity: z.string().min(2).max(300).describe("Short activity/task label"),
        severity: z.enum(["Low", "Medium", "High", "Critical"]).default("Medium"),
        stage: z.string().max(80).optional(),
        reason: z.string().max(1500).optional().describe("Why this alert is being raised, with citations"),
        root_cause: z.string().max(1500).optional(),
      }),
      execute: async ({ activity, severity, stage, reason, root_cause }) =>
        withTrace("create_alert", { activity, severity }, async () => {
          const flag_id = `CP-${Date.now().toString(36).toUpperCase()}`;
          const { data: row, error } = await supabase
            .from("alerts")
            .insert({
              flag_id,
              activity: activity.slice(0, 300),
              stage: stage ?? null,
              severity,
              source: "copilot",
              reason: reason ?? null,
              root_cause: root_cause ?? null,
              status: "open",
              sent_by: userId,
            })
            .select("id, flag_id")
            .single();
          if (error) return { error: error.message };
          return {
            _summary: `Created alert ${row.flag_id}`,
            _resultForModel: {
              alert_id: row.id,
              flag_id: row.flag_id,
              url: `/alerts/${row.id}`,
              message: `Alert ${row.flag_id} created. Visible on the Alerts page.`,
            },
          };
        }),
    });

    const draftEmail = tool({
      description:
        "Create a DRAFT email in the Agent Inbox for the user to review and approve before sending. Never sends directly. Use when the user asks to draft/write/prepare an email or nudge.",
      inputSchema: z.object({
        subject: z.string().min(2).max(200),
        body: z.string().min(2).max(6000),
        recipient_email: z.string().email().optional(),
        why: z.string().max(500).optional().describe("One-line rationale with citations"),
      }),
      execute: async ({ subject, body, recipient_email, why }) =>
        withTrace("draft_email", { subject, recipient_email }, async () => {
          const { data: row, error } = await supabase
            .from("agent_drafts")
            .insert({
              draft_type: "status_update",
              source_kind: "copilot",
              source_key: `copilot:${Date.now()}`,
              title: subject.slice(0, 200),
              subject,
              body,
              channel: "email",
              recipient_email: recipient_email ?? null,
              why: why ?? null,
              confidence: 0.7,
              state: "pending",
            })
            .select("id")
            .single();
          if (error) return { error: error.message };
          return {
            _summary: `Drafted email "${subject.slice(0, 60)}"`,
            _resultForModel: {
              draft_id: row.id,
              url: `/agent/inbox`,
              message: `Email drafted. Review & send from the Agent Inbox.`,
            },
          };
        }),
    });

    const createActivity = tool({
      description:
        "Create a tracked activity/task on a specific project. Use when the user asks to add/track a follow-up or obligation.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        title: z.string().min(2).max(300),
        description: z.string().max(2000).optional(),
        due_date: z.string().optional().describe("ISO date YYYY-MM-DD"),
        tat_days: z.number().int().min(1).max(365).optional(),
      }),
      execute: async ({ project_id, title, description, due_date, tat_days }) =>
        withTrace("create_activity", { project_id, title }, async () => {
          const { data: row, error } = await supabase
            .from("activities")
            .insert({
              project_id,
              title: title.slice(0, 300),
              description: description ?? null,
              due_date: due_date ?? null,
              tat_days: tat_days ?? null,
              status: "pending",
            })
            .select("id")
            .single();
          if (error) return { error: error.message };
          return {
            _summary: `Created activity "${title.slice(0, 60)}"`,
            _resultForModel: {
              activity_id: row.id,
              message: `Activity created on project. Visible on the project's activity list.`,
            },
          };
        }),
    });

    const listProjects = tool({
      description: "List projects the user can see (id + name). Call before create_activity when you don't have a project_id yet.",
      inputSchema: z.object({}),
      execute: async () =>
        withTrace("list_projects", {}, async () => {
          const { data: rows, error } = await supabase
            .from("projects")
            .select("id, name")
            .limit(50);
          if (error) return { error: error.message };
          return {
            _summary: `${rows?.length ?? 0} projects`,
            _resultForModel: { projects: rows ?? [] },
          };
        }),
    });


    // 4) System prompt — the agent has no rows, only tools.
    const catalog = {
      sheets: regs.map((r) => ({
        id: r.id,
        name: r.display_name,
        type: r.sheet_type,
        rows: r.row_count ?? 0,
      })),
      documents: docs.map((d) => ({
        id: d.id,
        name: d.name,
        pages: d.page_count ?? 0,
        summary: d.summary ?? null,
      })),
    };

    const system = [
      "You are the dashboard Copilot. You are STRICTLY scoped to the sheets and documents the user has selected for this turn (listed in the catalog below).",
      "You have NO memory of the underlying data — every fact must come from a tool call made in THIS turn against those selected sources.",
      "FORBIDDEN SOURCES: dashboard aggregates, KPI cards, cached summaries, prior turns' results, other sheets/documents not in the catalog below, general/world knowledge, and the internet. If a fact isn't obtainable by calling a tool against a source listed in the catalog, you do NOT know it — refuse with the fixed phrase.",
      "You must NEVER answer from prior/general knowledge, the internet, or any source outside the selected sheets/docs. If a question is off-topic (weather, general trivia, coding help, etc.), still attempt to answer it ONLY from the selected sources; if nothing relevant is there, refuse with the fixed phrase below.",

      "",
      "ANSWER-EVERYTHING POLICY (strict):",
      "- Try hard to answer ANY question the user asks — factual lookups, summaries, counts, comparisons, contacts (names/phones/emails), statuses, dates, aggregates, ranked lists, cross-sheet joins, document Q&A, etc.",
      "- Before refusing, you MUST exhaustively probe the selected sources:",
      "    1. Call get_sheet_schema on every selected sheet to learn its columns (canonical AND extras keys — contact info like phone/mobile/email often lives in extras).",
      "    2. Use search_sheet_rows with several rephrasings of the user's intent (synonyms, partial names, related terms).",
      "    3. Use filter_sheet_rows / aggregate_column / get_row / get_cell on the most likely columns (including extras columns).",
      "    4. Use search_doc_chunks on every selected document with multiple query rewrites.",
      "- Only after all reasonable probes return nothing may you refuse.",
      "- Never say 'I can only answer X'. If the data supports it, answer it.",
      "",
      "POSITIONAL / STRUCTURAL RULES (strict — apply BEFORE semantic search):",
      "- 'row N', 'the Nth row', 'first row', 'last row' → call get_row with row_index = N - 1 (the user's row numbers are ONE-BASED; internal row_index is ZERO-BASED). NEVER use search_sheet_rows for these — semantic search is useless for positional lookups.",
      "- 'first N rows' / 'top N rows' / 'show me a few rows' → call get_row for row_index 0, 1, ..., N-1 (max 10). Do not use search_sheet_rows.",
      "- 'how many rows', 'row count', 'size of the sheet' → call get_sheet_schema (its total_rows field is authoritative).",
      "- 'what columns/fields/headers are in <sheet>' → call get_sheet_schema and list the column names verbatim.",
      "",
      "DOCUMENT-SUMMARY RULE:",
      "- 'summarize this document', 'what is this doc about', 'overview of <doc>' → call search_doc_chunks on that document with several generic queries in parallel: 'introduction', 'overview', 'summary', 'purpose', 'conclusion', 'key points'. Then answer from the returned chunks and cite pages.",
      "",
      "PIN-TO-CELL RULE (strict):",
      "- When the user's question is about a specific field of a specific record (a single value: a phone, an email, a status, a date, a quantity, a name, etc.), you MUST call get_cell to fetch that exact (row, column) and cite it as [sheet:<display_name> row <n> col <ColumnName>]. Do NOT paraphrase the value from search results — fetch the exact cell.",
      "- The answer for such questions must state the column name and the exact value returned by get_cell, e.g. `Phone (col Mobile) = +91 98xxx — [sheet:Contacts row 42 col Mobile]`.",
      "",
      "CITATION RULES (strict):",
      "- Every factual sentence must include an inline citation marker:",
      "    [sheet:<display_name> row <n> col <ColumnName>] for a single-cell fact (preferred when the answer is one value), or",
      "    [sheet:<display_name> row <one-based row number>] or, for compact row summaries only, [sheet:<display_name> row 3, 9] / [sheet:<display_name> row 1-14] when every cited row was returned by a tool, or",
      "    [doc:<name> p.<page>]",
      "- Use [sheet:<display_name>] only for sheet-level facts such as total row count or schema/column coverage.",
      "- Only cite rows/chunks a tool actually returned in THIS turn.",
      "- End the answer with a `Sources:` list, one marker per line (deduplicated).",
      "- If you cannot support a claim from tool output, do not make it.",
      "- If, after the exhaustive probing above, no tool returned anything usable, respond EXACTLY:",
      '    "I don\'t have that in the current dashboard data."',
      "  then list the specific sheets/documents you searched and the queries you tried.",
      "",
      "STYLE:",
      "- Prefer short, precise answers with numbers and names.",
      "- When multiple rows matter, list them as a compact markdown table underneath the answer (using the citation marker in a trailing column named `source`).",
      "- Use Suggestion: prefix for any forward-looking advice.",
      "",
      "ACTION TOOLS (write — use ONLY when the user explicitly asks to take an action):",
      "- create_alert: raise a delay alert. Include supporting citations in `reason`.",
      "- draft_email: create a DRAFT in the Agent Inbox — never sends. Tell the user to review it there.",
      "- create_activity: add a tracked task to a project. Call list_projects first if you don't know the project_id.",
      "- After a successful action, confirm in one line and include the returned url/message.",
      "- Never take an action based on your own inference. Only act on an explicit user request in the current turn.",
      "",
      "AVAILABLE DATA CATALOG (these are the ONLY sources you may use; call get_sheet_schema for column details before filtering):",
      JSON.stringify(catalog).slice(0, 4000),
    ].join("\n");

    // 5) Assemble messages: prior history + new question.
    const messages = [
      ...data.history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: data.question },
    ];

    const gateway = createLovableAiGatewayProvider(key);
    const model = gateway("google/gemini-3-flash-preview");

    const toolset = {
      get_sheet_schema: getSheetSchema,
      search_sheet_rows: searchSheetRows,
      filter_sheet_rows: filterSheetRows,
      aggregate_column: aggregateColumn,
      get_row: getRow,
      get_cell: getCell,
      search_doc_chunks: searchDocChunks,
      create_alert: createAlert,
      draft_email: draftEmail,
      create_activity: createActivity,
      list_projects: listProjects,
    };

    async function runWithGeminiFallback(): Promise<{ text?: string }> {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        return {
          text:
            "I can't generate this right now because the AI provider is unavailable due to payment or quota limits, and no Gemini fallback key is configured. Your sheet data is still available; please retry after credits refresh.",
        };
      }
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey: geminiKey });
      toolTrace.push({
        name: "ai_model",
        args: { provider: "gemini_direct_fallback", model: "gemini-2.5-flash" },
        ok: true,
        ms: 0,
        summary: "Lovable AI unavailable — retrying with direct Gemini API (same tools).",
      });
      return await generateText({
        model: google("gemini-2.5-flash"),
        system,
        messages: messages as any,
        tools: toolset,
        stopWhen: stepCountIs(50),
      });
    }

    let result: { text?: string };
    try {
      result = await generateText({
        model,
        system,
        messages: messages as any,
        tools: toolset,
        stopWhen: stepCountIs(50),
      });
    } catch (error) {
      if (!isAiBillingOrQuotaError(error)) throw error;
      try {
        result = await runWithGeminiFallback();
      } catch (fallbackError) {
        toolTrace.push({
          name: "ai_model",
          args: { provider: "gemini_direct_fallback" },
          ok: false,
          ms: 0,
          summary: `Gemini fallback failed: ${(fallbackError as Error)?.message ?? "unknown"}`,
        });
        result = {
          text:
            "I can't generate this right now because both the Lovable AI Gateway and the Gemini fallback are unavailable. Please retry shortly.",
        };
      }
    }


    const rawAnswer = (result.text ?? "").trim();

    // 6) Structural citation validator against the ledger.
    const inlineRe = /\[([^\]\n]{2,}?)\]/g;
    const seen = new Set<string>();
    const verified = new Set<string>();
    const unverified: string[] = [];
    let inlineCount = 0;
    let m: RegExpExecArray | null;
    while ((m = inlineRe.exec(rawAnswer)) !== null) {
      // Skip markdown links [text](url)
      if (rawAnswer[m.index + m[0].length] === "(") continue;
      const marker = m[0];
      const body = m[1].trim();
      if (!/^(sheet:|doc:|flags?\[)/i.test(body)) continue;
      if (seen.has(marker)) continue;
      seen.add(marker);
      inlineCount++;

      // [sheet:<name> row <n>] plus compact forms [sheet:<name> row 1-14],
      // [sheet:<name> row 3, 9], [sheet:<name> row <n> col <column>], and
      // sheet-level [sheet:<name>].
      const sheetRowColMatch = /^sheet:\s*(.+?)\s+row\s+(\d+)\s+col\s+(.+?)\s*$/i.exec(body);
      const sheetRowMatch = !sheetRowColMatch
        ? /^sheet:\s*(.+?)\s+row\s+(.+?)\s*$/i.exec(body)
        : null;
      const sheetOnlyMatch =
        !sheetRowColMatch && !sheetRowMatch ? /^sheet:\s*(.+?)\s*$/i.exec(body) : null;
      if (sheetRowColMatch) {
        const label = normalizeCitationLabel(sheetRowColMatch[1]);
        const reg = sheetByLabel.get(label);
        if (!reg) {
          unverified.push(marker);
          continue;
        }
        const rowN = Number(sheetRowColMatch[2]);
        const inLedger = ledger.some(
          (l) => l.kind === "sheet_row" && l.registryId === reg.id && l.rowIndex === rowN - 1,
        );
        if (inLedger) verified.add(marker);
        else unverified.push(marker);
        continue;
      }
      if (sheetRowMatch || sheetOnlyMatch) {
        const label = normalizeCitationLabel(sheetRowMatch?.[1] ?? sheetOnlyMatch?.[1] ?? "");
        const reg = sheetByLabel.get(label);
        if (!reg) {
          unverified.push(marker);
          continue;
        }
        if (!sheetRowMatch) {
          verified.add(marker);
          continue;
        }
        const rows = parseCitationRowSpec(sheetRowMatch[2]);
        if (!rows) {
          unverified.push(marker);
          continue;
        }
        const allInLedger = rows.every((rowN) =>
          ledger.some(
            (l) => l.kind === "sheet_row" && l.registryId === reg.id && l.rowIndex === rowN - 1,
          ),
        );
        if (allInLedger) verified.add(marker);
        else unverified.push(marker);
        continue;
      }
      // [doc:<name> p.<n>] and document-level [doc:<name>].
      const docPageMatch = /^doc:\s*(.+?)\s+p\.?\s*(\d+)\s*$/i.exec(body);
      const docOnlyMatch = !docPageMatch ? /^doc:\s*(.+?)\s*$/i.exec(body) : null;
      if (docPageMatch || docOnlyMatch) {
        const label = normalizeCitationLabel(docPageMatch?.[1] ?? docOnlyMatch?.[1] ?? "");
        const doc = docByLabel.get(label);
        if (!doc) {
          unverified.push(marker);
          continue;
        }
        if (!docPageMatch) {
          verified.add(marker);
          continue;
        }
        const page = Number(docPageMatch[2]);
        const inLedger = ledger.some(
          (l) => l.kind === "doc_chunk" && l.documentId === doc.id && l.pageNo === page,
        );
        if (inLedger) verified.add(marker);
        else unverified.push(marker);
        continue;
      }
      // Legacy flag references are not row/doc grounded, but they are intentional
      // citation markers from older answers and should not make unrelated sheet/doc
      // citations look malformed.
      if (/^flags?\[.+\]$/i.test(body)) verified.add(marker);
    }

    const isFallback =
      /^i don'?t have that in the current dashboard data\.?$/i.test(rawAnswer);
    const hasSourcesSection = /(^|\n)\s*sources\s*:/i.test(rawAnswer);
    let finalAnswer = rawAnswer;
    if (!opts.skipCitationEnforcement && !isFallback && !hasSourcesSection && verified.size > 0) {
      finalAnswer = `${rawAnswer}\n\nSources:\n${Array.from(verified).map((marker) => `- ${marker}`).join("\n")}`;
    }
    const finalHasSourcesSection = /(^|\n)\s*sources\s*:/i.test(finalAnswer);
    const citationOk =
      isFallback ||
      (inlineCount > 0 && verified.size > 0 && unverified.length === 0 && finalHasSourcesSection);

    // 7) If nothing verified and not a fallback, replace with refusal.
    if (!opts.skipCitationEnforcement && !citationOk && !isFallback && (inlineCount === 0 || unverified.length === inlineCount)) {
      finalAnswer = "I don't have that in the current dashboard data.";
    }


    // 8) Shape sources for the existing UI (id, name, type, rowsUsed, truncated).
    const rowsUsedBySheet = new Map<string, number>();
    const docsUsed = new Map<string, number>();
    for (const l of ledger) {
      if (l.kind === "sheet_row") {
        rowsUsedBySheet.set(l.registryId, (rowsUsedBySheet.get(l.registryId) ?? 0) + 1);
      } else {
        docsUsed.set(l.documentId, (docsUsed.get(l.documentId) ?? 0) + 1);
      }
    }
    const sources = [
      ...regs.map((r) => ({
        id: r.id,
        name: r.display_name,
        type: r.sheet_type,
        rowsTotal: r.row_count ?? 0,
        rowsUsed: rowsUsedBySheet.get(r.id) ?? 0,
        truncated: false,
      })),
      ...docs.map((d) => ({
        id: d.id,
        name: d.name,
        type: "document",
        rowsTotal: 0,
        rowsUsed: docsUsed.get(d.id) ?? 0,
        truncated: false,
      })),
    ];

    // 9) Persist for history + audit.
    await supabase.from("copilot_messages").insert([
      {
        user_id: userId,
        role: "user",
        content: data.question,
        scope: { sheetIds: data.sheetIds, documentIds: data.documentIds },
      },
      {
        user_id: userId,
        role: "assistant",
        content: finalAnswer,
        scope: { sheetIds: data.sheetIds, documentIds: data.documentIds },
        citations: sources,
      },
    ]);

    // 10) Follow-up suggestions (best-effort, non-blocking).
    let suggestions: string[] = [];
    try {
      const sug = await generateText({
        model,
        system:
          "Produce exactly 3 short follow-up questions the user might ask next. Output ONLY a JSON array of 3 strings.",
        prompt: `QUESTION: ${data.question}\nANSWER: ${finalAnswer.slice(0, 2000)}`,
      });
      const parsed = JSON.parse(sug.text.trim().replace(/^```(?:json)?\n?|\n?```$/g, ""));
      if (Array.isArray(parsed)) suggestions = parsed.filter((s) => typeof s === "string").slice(0, 3);
    } catch {
      /* ignore */
    }

    return {
      answer: finalAnswer,
      sources,
      suggestions,
      toolTrace,
      retrievalLedger: ledger.map((l) =>
        l.kind === "sheet_row"
          ? {
              kind: "sheet_row" as const,
              sheetId: l.registryId,
              sheetLabel: l.sheetLabel,
              rowIndex: l.rowIndex,
            }
          : {
              kind: "doc_chunk" as const,
              documentId: l.documentId,
              documentName: l.documentName,
              pageNo: l.pageNo,
            },
      ),
      citationOk,
      unverifiedCitations: unverified,
    };
  }


export const askCopilotV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    return await runCopilotAgent(data, { supabase: context.supabase, userId: context.userId });
  });

