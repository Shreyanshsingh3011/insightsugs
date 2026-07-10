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
    const directGeminiKey = process.env.GEMINI_API_KEY;
    // No throw when both providers are missing: we fall back to the
    // deterministic no-LLM engine below so the copilot keeps answering
    // simple sheet/document questions without any AI credits.

    // Lazy-load heavy AI SDK + gateway to keep SSR bundle slim.
    const [{ generateText, stepCountIs, tool }, gatewayModule] = await Promise.all([
      import("ai"),
      key ? import("@/lib/ai-gateway") : Promise.resolve(null),
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

          // Try vector search first; fall back to keyword scan when embeddings
          // are unavailable (402/429) OR when the RPC returns zero matches
          // (missing/mismatched embeddings for this sheet). Guarantees the
          // model always gets rows so it never refuses on a valid selected sheet.
          let matches: Array<{ row_index: number; similarity?: number }> = [];
          let mode: "vector" | "keyword" | "recent" = "vector";
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
            // handled below via keyword fallback
          }

          if (matches.length === 0) {
            mode = "keyword";
            const tokens = query
              .toLowerCase()
              .split(/[^a-z0-9]+/i)
              .filter((t) => t.length >= 3);
            const scored = rows.map((r) => {
              // Include column headers so questions like "Which Start Date…"
              // still match rows in a "Start Date" column.
              const hay = [
                ...Object.keys(r.data),
                ...Object.values(r.data).map((v) => String(v ?? "")),
              ]
                .join(" \u0001 ")
                .toLowerCase();
              let score = 0;
              for (const t of tokens) if (hay.includes(t)) score++;
              return { row_index: r.row_index, similarity: score };
            });
            scored.sort((a, b) => b.similarity - a.similarity);
            const anyHit = scored.some((s) => s.similarity > 0);
            if (anyHit) {
              matches = scored.filter((s) => s.similarity > 0).slice(0, k);
            } else {
              // Last-resort: hand the model the first k rows so it can still
              // answer generic/temporal questions from the selected sheet
              // instead of refusing with "no data".
              mode = "recent";
              matches = rows.slice(0, k).map((r) => ({ row_index: r.row_index, similarity: 0 }));
            }
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

    // ---------- TEMPORAL QUERY TOOL ----------
    // Translates "earliest / latest / overdue / due within N days / older than
    // N days / between D1 and D2 / TAT breached" into deterministic filters
    // over any date-like column. Semantic search is bad at these; this tool
    // is exact.
    const DATE_COL_HINTS = [
      "date", "due", "deadline", "start", "end", "eta", "target",
      "planned", "actual", "completion", "closed", "opened", "created",
      "updated", "expires", "expiry", "receipt", "dispatch", "delivery",
      "schedule", "milestone",
    ];

    function parseAnyDate(v: unknown): Date | null {
      if (v == null || v === "") return null;
      if (v instanceof Date) return isNaN(+v) ? null : v;
      const s = String(v).trim();
      if (!s) return null;
      // Excel serial (rough): 5-digit number in a plausible range.
      if (/^\d{4,6}$/.test(s)) {
        const n = Number(s);
        if (n > 20000 && n < 80000) {
          const ms = (n - 25569) * 86400 * 1000;
          const d = new Date(ms);
          if (!isNaN(+d)) return d;
        }
      }
      // dd/mm/yyyy or dd-mm-yyyy
      const dmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
      if (dmy) {
        let [, d, m, y] = dmy;
        if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
        const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        const dt = new Date(iso);
        if (!isNaN(+dt)) return dt;
      }
      const dt = new Date(s);
      return isNaN(+dt) ? null : dt;
    }

    function pickDateColumns(rows: Array<{ data: Record<string, unknown> }>, hint?: string | null): string[] {
      if (rows.length === 0) return [];
      const keys = new Set<string>();
      for (const r of rows.slice(0, 200)) for (const k of Object.keys(r.data)) keys.add(k);
      const scored: Array<{ key: string; score: number; parseRate: number }> = [];
      for (const k of keys) {
        const kl = k.toLowerCase();
        const nameHit = DATE_COL_HINTS.some((h) => kl.includes(h));
        let parsed = 0;
        let non_empty = 0;
        for (const r of rows.slice(0, 150)) {
          const v = r.data[k];
          if (v == null || v === "") continue;
          non_empty++;
          if (parseAnyDate(v)) parsed++;
        }
        const rate = non_empty > 0 ? parsed / non_empty : 0;
        // A column is date-like if either name matches AND >30% parse,
        // OR >70% parse regardless of name.
        if ((nameHit && rate >= 0.3) || rate >= 0.7) {
          const hintBoost = hint && kl.includes(hint.toLowerCase()) ? 5 : 0;
          scored.push({ key: k, score: (nameHit ? 2 : 0) + rate + hintBoost, parseRate: rate });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.map((s) => s.key);
    }

    const dateQueryRows = tool({
      description:
        "Deterministic temporal filter for a sheet. Use for questions about 'earliest', 'latest', 'overdue', 'due within N days', 'older than N days', 'between D1 and D2', TAT breaches, or any date-range/ordering question. Auto-detects date columns; pass `column` to force one. Returns rows with the parsed date, sorted appropriately.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        op: z.enum([
          "earliest",
          "latest",
          "overdue",
          "due_within",
          "older_than",
          "between",
          "tat_breached",
        ]),
        column: z.string().min(1).max(120).nullable().default(null).describe(
          "Optional date column. If omitted, the tool picks the best date-like column (or the one whose name best matches the user's phrasing).",
        ),
        column_hint: z.string().max(60).nullable().default(null).describe(
          "Optional word from the user's question to bias column pick (e.g. 'start', 'due', 'delivery').",
        ),
        days: z.number().int().min(0).max(3650).nullable().default(null).describe(
          "Window size for due_within / older_than / tat_breached (defaults 7).",
        ),
        from: z.string().nullable().default(null).describe("ISO date for `between` (inclusive)."),
        to: z.string().nullable().default(null).describe("ISO date for `between` (inclusive)."),
        tat_column: z.string().max(120).nullable().default(null).describe(
          "For tat_breached: name of the TAT-days numeric column. If omitted, a column whose name contains 'tat' is used.",
        ),
        status_column: z.string().max(120).nullable().default(null).describe(
          "For overdue / tat_breached: name of the status column so completed/closed/done rows are excluded.",
        ),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      execute: async ({ sheet_id, op, column, column_hint, days, from, to, tat_column, status_column, limit }) =>
        withTrace(
          "date_query_rows",
          { sheet_id, op, column, column_hint, days, from, to, tat_column, status_column, limit },
          async () => {
            const reg = sheetById.get(sheet_id);
            if (!reg) return { error: "Unknown sheet_id" };
            const rows = await getSheetRows(sheet_id);
            if (rows.length === 0) {
              return { _summary: "0 rows in sheet", _resultForModel: { sheet: reg.display_name, op, rows: [] } };
            }

            // Resolve date column (case-insensitive match if user supplied one).
            let dateCol = column
              ? Object.keys(rows[0]?.data ?? {}).find(
                  (k) => k.toLowerCase().trim() === column.toLowerCase().trim(),
                ) ?? null
              : null;
            if (!dateCol) {
              const candidates = pickDateColumns(rows, column_hint);
              dateCol = candidates[0] ?? null;
            }
            if (!dateCol) {
              return {
                error:
                  "No date-like column detected. Call get_sheet_schema and re-run with an explicit `column`.",
              };
            }

            // Terminal-status exclusion (for overdue / tat_breached).
            const terminal = /^(done|closed|complete|completed|finished|delivered|cancelled|canceled|dispatched|received)$/i;
            const statusKey = status_column
              ? Object.keys(rows[0]?.data ?? {}).find(
                  (k) => k.toLowerCase().trim() === status_column.toLowerCase().trim(),
                )
              : Object.keys(rows[0]?.data ?? {}).find((k) => /status|stage|state/i.test(k));

            const now = new Date();
            const dayMs = 86400 * 1000;
            const windowDays = days ?? 7;

            // Build (row, parsedDate) tuples.
            const parsed: Array<{
              row_index: number;
              data: Record<string, unknown>;
              date: Date;
              statusVal: string | null;
            }> = [];
            for (const r of rows) {
              const dt = parseAnyDate(r.data[dateCol]);
              if (!dt) continue;
              parsed.push({
                row_index: r.row_index,
                data: r.data,
                date: dt,
                statusVal: statusKey ? String(r.data[statusKey] ?? "").trim() : null,
              });
            }

            const excludeTerminal = (t: typeof parsed) =>
              t.filter((r) => !(r.statusVal && terminal.test(r.statusVal)));

            let picked: typeof parsed = [];
            let explain = "";
            if (op === "earliest") {
              picked = [...parsed].sort((a, b) => +a.date - +b.date).slice(0, limit);
              explain = `earliest by ${dateCol}`;
            } else if (op === "latest") {
              picked = [...parsed].sort((a, b) => +b.date - +a.date).slice(0, limit);
              explain = `latest by ${dateCol}`;
            } else if (op === "overdue") {
              picked = excludeTerminal(parsed)
                .filter((r) => +r.date < +now)
                .sort((a, b) => +a.date - +b.date)
                .slice(0, limit);
              explain = `overdue on ${dateCol} (not in terminal status)`;
            } else if (op === "due_within") {
              const horizon = +now + windowDays * dayMs;
              picked = excludeTerminal(parsed)
                .filter((r) => +r.date >= +now && +r.date <= horizon)
                .sort((a, b) => +a.date - +b.date)
                .slice(0, limit);
              explain = `${dateCol} due in next ${windowDays} days`;
            } else if (op === "older_than") {
              const cutoff = +now - windowDays * dayMs;
              picked = parsed
                .filter((r) => +r.date <= cutoff)
                .sort((a, b) => +a.date - +b.date)
                .slice(0, limit);
              explain = `${dateCol} older than ${windowDays} days`;
            } else if (op === "between") {
              const f = from ? parseAnyDate(from) : null;
              const t = to ? parseAnyDate(to) : null;
              if (!f || !t) return { error: "`between` requires ISO `from` and `to`." };
              picked = parsed
                .filter((r) => +r.date >= +f && +r.date <= +t)
                .sort((a, b) => +a.date - +b.date)
                .slice(0, limit);
              explain = `${dateCol} between ${f.toISOString().slice(0, 10)} and ${t.toISOString().slice(0, 10)}`;
            } else if (op === "tat_breached") {
              const tatKey = tat_column
                ? Object.keys(rows[0]?.data ?? {}).find(
                    (k) => k.toLowerCase().trim() === tat_column.toLowerCase().trim(),
                  )
                : Object.keys(rows[0]?.data ?? {}).find((k) => /\btat\b/i.test(k));
              if (!tatKey) {
                return {
                  error:
                    "No TAT column found. Call get_sheet_schema and pass `tat_column` (a numeric days column).",
                };
              }
              const breached = excludeTerminal(parsed)
                .map((r) => {
                  const tat = Number(r.data[tatKey]);
                  if (!Number.isFinite(tat)) return null;
                  const ageDays = Math.floor((+now - +r.date) / dayMs);
                  return ageDays > tat
                    ? { ...r, tat, ageDays, over: ageDays - tat }
                    : null;
                })
                .filter((x): x is NonNullable<typeof x> => x != null)
                .sort((a, b) => b.over - a.over)
                .slice(0, limit);
              picked = breached as unknown as typeof parsed;
              explain = `TAT breached: ${dateCol} vs ${tatKey}`;
            }

            for (const r of picked) {
              ledger.push({
                kind: "sheet_row",
                registryId: sheet_id,
                sheetLabel: reg.display_name,
                rowIndex: r.row_index,
                data: r.data,
              });
            }

            return {
              _summary: `${picked.length} rows — ${explain} in "${reg.display_name}"`,
              _resultForModel: {
                sheet: reg.display_name,
                op,
                date_column: dateCol,
                status_column: statusKey ?? null,
                window_days: op === "due_within" || op === "older_than" || op === "tat_breached" ? windowDays : null,
                total_parsed: parsed.length,
                total_rows: rows.length,
                rows: picked.map((r) => ({
                  row_index: r.row_index,
                  date: r.date.toISOString().slice(0, 10),
                  data: r.data,
                  cite: `[sheet:${reg.display_name} row ${r.row_index + 1} col ${dateCol}]`,
                })),
              },
            };
          },
        ),
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
          let matches: any[] = [];
          let mode: "vector" | "keyword" = "vector";
          try {
            // Doc chunks are stored at 768d (google/gemini-embedding-001 via
            // documents.server.embedTexts). Must query with the SAME model or
            // pgvector's <=> errors on dim mismatch and the RPC returns nothing.
            const { embedTexts: embedDocQuery } = await import("./documents.server");
            const [qvec] = await embedDocQuery([query]);
            const { data: vectorMatches, error } = await supabase.rpc("match_doc_chunks", {
              _user_id: userId,
              _query: qvec as any,
              _scope_folder: null as unknown as string,
              _scope_document: document_id,
              _match_count: k,
            });
            if (error) throw new Error(error.message);
            matches = (vectorMatches ?? []) as any[];
          } catch {
            mode = "keyword";
            const { data: chunks, error } = await supabase
              .from("document_chunks")
              .select("document_id, content, page_no")
              .eq("document_id", document_id)
              .limit(300);
            if (error) return { error: error.message };
            const tokens = query
              .toLowerCase()
              .split(/[^a-z0-9]+/i)
              .filter((t) => t.length >= 3);
            const scored = ((chunks ?? []) as any[]).map((chunk) => {
              const hay = String(chunk.content ?? "").toLowerCase();
              let score = 0;
              for (const token of tokens) if (hay.includes(token)) score++;
              return { ...chunk, document_name: doc.name, similarity: score };
            });
            scored.sort((a, b) => Number(b.similarity ?? 0) - Number(a.similarity ?? 0));
            const anyHit = scored.some((s) => Number(s.similarity ?? 0) > 0);
            matches = (anyHit ? scored.filter((s) => Number(s.similarity ?? 0) > 0) : scored).slice(0, k);
          }
          const results = matches.map((m: any) => {
            ledger.push({
              kind: "doc_chunk",
              documentId: m.document_id ?? document_id,
              documentName: m.document_name ?? doc.name,
              pageNo: m.page_no ?? 0,
              snippet: m.content ?? "",
            });
            return {
              document: m.document_name ?? doc.name,
              page: m.page_no ?? 0,
              snippet: (m.content ?? "").slice(0, 400),
              similarity: Number(m.similarity?.toFixed?.(3) ?? 0),
              cite: `[doc:${m.document_name ?? doc.name} p.${m.page_no ?? 0}]`,
            };
          });
          return {
            _summary: `${results.length} chunks from "${doc.name}" (${mode})`,
            _resultForModel: { document: doc.name, mode, matches: results },
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
      "",
      "TEMPORAL RULE (strict — apply BEFORE search_sheet_rows for time-based questions):",
      "- ANY question mentioning 'earliest/oldest/first', 'latest/most recent/newest', 'overdue/past due/late', 'due (today|tomorrow|this week|in N days|soon)', 'older than N days/weeks/months', 'between <date> and <date>', 'TAT (breach|breached|exceeded|missed)', 'delayed', 'aging', 'ETA slipped' → CALL date_query_rows with the correct `op`:",
      "    earliest      → op='earliest'",
      "    latest        → op='latest'",
      "    overdue / past due / late          → op='overdue'",
      "    due within N (today/tomorrow/week) → op='due_within', days=N (today=0, tomorrow=1, this week=7, this month=30)",
      "    older than N days                  → op='older_than', days=N",
      "    between D1 and D2                  → op='between', from=D1 (ISO), to=D2 (ISO)",
      "    TAT breached / SLA missed          → op='tat_breached'",
      "- Pass `column_hint` = the user's date-noun ('start','due','delivery','receipt','dispatch','ETA') so the auto-detector picks the right column.",
      "- If the sheet has a status column, the tool auto-excludes rows whose status is done/closed/completed/dispatched/received.",
      "- If date_query_rows errors with 'No date-like column detected', call get_sheet_schema, then re-run with an explicit `column`.",
      "- After the call, answer with exact dates and cite each row as [sheet:<display_name> row <n> col <date_column>].",
      "",
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

    // 5a) TEMPORAL PRE-FLIGHT — deterministically run date_query_rows for
    // temporal questions on every scoped sheet, seed the ledger, and inject
    // the results into the system prompt. This guarantees the answer is
    // grounded in the selected sheet even when the model skips the tool
    // (e.g. Gemini fallback under 402 pressure).
    const qLower = data.question.toLowerCase();
    const temporalOp: "earliest" | "latest" | "overdue" | "tat_breached" | null =
      /\b(earliest|oldest|first\s+(start|due|delivery|dispatch|receipt|eta))\b/.test(qLower)
        ? "earliest"
        : /\b(latest|most\s+recent|newest|last\s+(start|due|delivery|dispatch|receipt|eta))\b/.test(qLower)
          ? "latest"
          : /\b(overdue|past\s+due|late|slipped|behind\s+schedule)\b/.test(qLower)
            ? "overdue"
            : /\btat\b.*\b(breach|missed|exceed|over)|sla\s+(missed|breach)/.test(qLower)
              ? "tat_breached"
              : null;
    const columnHint = /start/.test(qLower)
      ? "start"
      : /due|deadline/.test(qLower)
        ? "due"
        : /deliver/.test(qLower)
          ? "delivery"
          : /\beta\b/.test(qLower)
            ? "eta"
            : /receipt/.test(qLower)
              ? "receipt"
              : /dispatch/.test(qLower)
                ? "dispatch"
                : null;

    const preflightBlocks: string[] = [];
    const preflightCites: string[] = [];
    let preflightDateColumn: string | null = null;
    if (temporalOp && regs.length > 0) {
      for (const r of regs) {
        try {
          const res: any = await (dateQueryRows as any).execute?.({
            sheet_id: r.id,
            op: temporalOp,
            column: null,
            column_hint: columnHint,
            days: null,
            from: null,
            to: null,
            tat_column: null,
            status_column: null,
            limit: 15,
          });
          if (res?._resultForModel?.rows?.length) {
            preflightDateColumn = res._resultForModel.date_column ?? preflightDateColumn;
            for (const row of res._resultForModel.rows) {
              if (typeof row?.cite === "string") preflightCites.push(row.cite);
            }
            preflightBlocks.push(
              `Sheet "${r.display_name}" — op=${temporalOp}${columnHint ? `, hint=${columnHint}` : ""}, date_column=${res._resultForModel.date_column}:\n` +
                JSON.stringify(res._resultForModel.rows).slice(0, 3500),
            );
          } else if (res?.error) {
            preflightBlocks.push(`Sheet "${r.display_name}" — ${res.error}`);
          } else {
            preflightBlocks.push(`Sheet "${r.display_name}" — 0 rows matched op=${temporalOp}.`);
          }
        } catch (e) {
          preflightBlocks.push(`Sheet "${r.display_name}" — preflight failed: ${(e as Error)?.message ?? "error"}`);
        }
      }
    }
    const systemWithPreflight = preflightBlocks.length
      ? system +
        "\n\nPRE-FLIGHT RESULTS (already executed against the selected sheet(s) — DO NOT call date_query_rows again for the same question; answer directly from these rows and cite each one using the `cite` marker from the row):\n\n" +
        preflightBlocks.join("\n\n")
      : system;


    const toolset = {
      get_sheet_schema: getSheetSchema,
      search_sheet_rows: searchSheetRows,
      filter_sheet_rows: filterSheetRows,
      aggregate_column: aggregateColumn,
      get_row: getRow,
      get_cell: getCell,
      date_query_rows: dateQueryRows,
      search_doc_chunks: searchDocChunks,
      create_alert: createAlert,
      draft_email: draftEmail,
      create_activity: createActivity,
      list_projects: listProjects,
    };

    async function runDeterministic(reason: string): Promise<{ text?: string }> {
      const { deterministicAnswer } = await import("./copilot-deterministic.server");
      const det = await deterministicAnswer({
        supabase,
        question: data.question,
        regs: regs.map((r) => ({ id: r.id, display_name: r.display_name })),
        docs: docs.map((d) => ({ id: d.id, name: d.name })),
        ledgerSink: ledger as any,
      });
      toolTrace.push({
        name: "ai_model",
        args: { provider: "deterministic_no_llm", reason },
        ok: det.matched,
        ms: 0,
        summary: det.matched
          ? `Answered without an LLM using local search over ${regs.length} sheet(s) and ${docs.length} document(s).`
          : `Deterministic engine could not find matching data (${reason}).`,
      });
      if (!det.matched) {
        return {
          text:
            "I couldn't reach the AI provider and my local search didn't find matching rows in the selected sheets or documents. Try a more specific keyword or select a different sheet.",
        };
      }
      return { text: det.answer };
    }

    async function runWithGeminiFallback(): Promise<{ text?: string }> {
      if (!directGeminiKey) {
        return await runDeterministic("no_gemini_key");
      }
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      const google = createGoogleGenerativeAI({ apiKey: directGeminiKey });
      toolTrace.push({
        name: "ai_model",
        args: { provider: "gemini_direct_fallback", model: "gemini-2.5-flash" },
        ok: true,
        ms: 0,
        summary: "Lovable AI unavailable — retrying with direct Gemini API (same tools).",
      });
      try {
        return await generateText({
          model: google("gemini-2.5-flash"),
          system: systemWithPreflight,
          messages: messages as any,
          tools: toolset,
          stopWhen: stepCountIs(50),
        });
      } catch (e) {
        return await runDeterministic(`gemini_error:${(e as Error)?.message ?? "unknown"}`);
      }
    }

    let result: { text?: string };
    if (!key) {
      result = await runWithGeminiFallback();
    } else {
      try {
        const gateway = gatewayModule!.createLovableAiGatewayProvider(key);
        const model = gateway("google/gemini-3-flash-preview");
        result = await generateText({
          model,
          system: systemWithPreflight,
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

    // 7) If nothing verified and not a fallback, replace with refusal —
    // unless a deterministic pre-flight already seeded rows into the ledger,
    // in which case synthesize a grounded answer from those rows so we never
    // refuse when the selected sheet actually contains the data.
    if (!opts.skipCitationEnforcement && temporalOp && isFallback) {
      const preflightRows = ledger.filter((l): l is Extract<LedgerEntry, { kind: "sheet_row" }> => l.kind === "sheet_row");
      if (preflightRows.length > 0) {
        const lines: string[] = [];
        const seenReg = new Set<string>();
        const bySheet = new Map<string, typeof preflightRows>();
        for (const r of preflightRows) {
          if (!bySheet.has(r.registryId)) bySheet.set(r.registryId, [] as any);
          (bySheet.get(r.registryId) as any).push(r);
        }
        const cites: string[] = [];
        for (const [regId, rows] of bySheet) {
          const reg = sheetById.get(regId);
          if (!reg) continue;
          seenReg.add(reg.display_name);
          lines.push(`**${reg.display_name}** — top ${rows.length} ${temporalOp === "overdue" ? "overdue" : temporalOp === "tat_breached" ? "TAT-breached" : temporalOp} entries${preflightDateColumn ? ` by \`${preflightDateColumn}\`` : ""}:`);
          for (const r of rows.slice(0, 10)) {
            const marker = preflightCites.find((cite) => cite.includes(`sheet:${reg.display_name} row ${r.rowIndex + 1} `)) ?? `[sheet:${reg.display_name} row ${r.rowIndex + 1}]`;
            const preview = Object.entries(r.data)
              .filter(([, v]) => v != null && String(v).trim() !== "")
              .slice(0, 5)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
              .join(" · ");
            lines.push(`- ${preview} ${marker}`);
            cites.push(marker);
          }
        }
        finalAnswer =
          `I found matching ${temporalOp === "overdue" ? "overdue" : temporalOp === "tat_breached" ? "TAT-breached" : temporalOp} entries in the selected sheet, not dashboard data:\n\n` +
          lines.join("\n") +
          `\n\nSources:\n${Array.from(new Set(cites)).map((m) => `- ${m}`).join("\n")}`;
      }
    }

    if (!opts.skipCitationEnforcement && !citationOk && !isFallback && (inlineCount === 0 || unverified.length === inlineCount)) {
      const preflightRows = ledger.filter((l): l is Extract<LedgerEntry, { kind: "sheet_row" }> => l.kind === "sheet_row");
      if (temporalOp && preflightRows.length > 0) {
        const lines: string[] = [];
        const seenReg = new Set<string>();
        const bySheet = new Map<string, typeof preflightRows>();
        for (const r of preflightRows) {
          if (!bySheet.has(r.registryId)) bySheet.set(r.registryId, [] as any);
          (bySheet.get(r.registryId) as any).push(r);
        }
        const cites: string[] = [];
        for (const [regId, rows] of bySheet) {
          const reg = sheetById.get(regId);
          if (!reg) continue;
          seenReg.add(reg.display_name);
          lines.push(`**${reg.display_name}** — top ${rows.length} by \`${temporalOp}\`:`);
          for (const r of rows.slice(0, 10)) {
            const preview = Object.entries(r.data)
              .filter(([, v]) => v != null && String(v).trim() !== "")
              .slice(0, 4)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
              .join(" · ");
            const marker = `[sheet:${reg.display_name} row ${r.rowIndex + 1}]`;
            lines.push(`- ${preview} ${marker}`);
            cites.push(marker);
          }
        }
        finalAnswer =
          `Here are the ${temporalOp === "overdue" ? "overdue" : temporalOp === "tat_breached" ? "TAT-breached" : temporalOp} entries from ${Array.from(seenReg).join(", ")}:\n\n` +
          lines.join("\n") +
          `\n\nSources:\n${Array.from(new Set(cites)).map((m) => `- ${m}`).join("\n")}`;
      } else {
        finalAnswer = "I don't have that in the current dashboard data.";
      }
    }



    const finalMarkers = new Set<string>();
    const finalInlineRe = /\[([^\]\n]{2,}?)\]/g;
    let finalMarkerMatch: RegExpExecArray | null;
    while ((finalMarkerMatch = finalInlineRe.exec(finalAnswer)) !== null) {
      if (finalAnswer[finalMarkerMatch.index + finalMarkerMatch[0].length] === "(") continue;
      const body = finalMarkerMatch[1].trim();
      if (/^(sheet:|doc:|flags?\[)/i.test(body)) finalMarkers.add(finalMarkerMatch[0]);
    }
    const finalCitationOk =
      /^i don'?t have that in the current dashboard data\.?$/i.test(finalAnswer.trim()) ||
      (finalMarkers.size > 0 && /(^|\n)\s*sources\s*:/i.test(finalAnswer));

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
      let suggestionModel: any;
      if (directGeminiKey) {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        suggestionModel = createGoogleGenerativeAI({ apiKey: directGeminiKey })("gemini-2.5-flash");
      } else if (key && gatewayModule) {
        suggestionModel = gatewayModule.createLovableAiGatewayProvider(key)("google/gemini-3-flash-preview");
      }
      if (!suggestionModel) throw new Error("No suggestion model available");
      const sug = await generateText({
        model: suggestionModel,
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
      citationOk: finalCitationOk,
      unverifiedCitations: finalCitationOk ? [] : unverified,
    };
  }


export const askCopilotV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    return await runCopilotAgent(data, { supabase: context.supabase, userId: context.userId });
  });

