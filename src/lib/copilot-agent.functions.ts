// Agentic Copilot: the model plans and calls tools that read your sheets/docs.
// The model NEVER sees raw rows in its system prompt; every fact it can cite
// must come from a tool it explicitly called this turn. See plan for the
// full contract.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isTransientDataApiError } from "./transient-errors";
import {
  mergeRow,
  stringifyRow,
  normalizeCitationLabel,
  parseCitationRowSpec,
  isAiBillingOrQuotaError,
  fetchAllRows,
} from "./copilot-helpers.server";
import { ensureSheetEmbeddings } from "./copilot-embeddings.server";
import { getSheetIndex, candidatesForTokens, type SheetIndex } from "./copilot-index.server";

// Re-export so existing importers (e.g. the embed-backfill hook) keep working.
export { ensureSheetEmbeddings };

// Silence unused-import warnings for helpers used deep inside runCopilotAgent
// via bundler tree-shaking analysis. These are all referenced further below.
void mergeRow;
void stringifyRow;
void normalizeCitationLabel;
void parseCitationRowSpec;
void isAiBillingOrQuotaError;
void fetchAllRows;

// Heavy AI SDK + gateway modules are lazy-loaded inside the handler to keep
// them out of the SSR entry bundle.


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
    // When true, ONLY contiguous full-phrase matches are returned. No
    // per-token AND fallback, no "recent rows" fallback, no surname-only
    // leakage. If nothing matches strictly, the copilot says so.
    strictMatch: z.boolean().optional(),
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
    const readWithRetry = async <T,>(label: string, run: () => Promise<{ data: T; error: any }>) => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await run();
        if (!result.error) return result;
        lastError = result.error;
        if (!isTransientDataApiError(result.error) || attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
      console.warn(`Copilot ${label} lookup failed after retries.`, lastError);
      return { data: [] as T, error: lastError };
    };

    const [regsRes, docsRes] = await Promise.all([
      data.sheetIds.length
        ? readWithRetry("sheet registry", () =>
            supabase
              .from("sheet_registry")
              .select("id, display_name, sheet_type, row_count")
              .in("id", data.sheetIds),
          )
        : Promise.resolve({ data: [] as any[], error: null }),

      data.documentIds.length
        ? readWithRetry("document", () =>
            supabase
              .from("documents")
              .select("id, name, summary, page_count")
              .in("id", data.documentIds),
          )
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
    const cachedIndexBySheet = new Map<string, SheetIndex>();

    const getSheetIndexCached = async (registryId: string): Promise<SheetIndex> => {
      const cached = cachedIndexBySheet.get(registryId);
      if (cached) return cached;
      const idx = await getSheetIndex(supabase, registryId);
      cachedIndexBySheet.set(registryId, idx);
      return idx;
    };

    const getSheetRows = async (registryId: string) => {
      const idx = await getSheetIndexCached(registryId);
      return idx.rows;
    };

    const rowColumns = (rows: Array<{ data: Record<string, unknown> }>) => {
      const cols = new Set<string>();
      for (const r of rows) for (const k of Object.keys(r.data)) cols.add(k);
      return Array.from(cols);
    };

    const resolveColumn = (want: string, columns: string[]) => {
      const exact = columns.find((c) => c.toLowerCase().trim() === want.toLowerCase().trim());
      if (exact) return exact;
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const w = norm(want);
      return columns.find((c) => norm(c) === w) ?? null;
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
          const idx = await getSheetIndexCached(sheet_id);
          const rows = idx.rows;
          const byIndex = idx.byIndex;
          const { strictPhrases, normalizeHaystack, matchesAllPhrases, countPhraseHits, contentTokens, extractRequestedColumns } =
            await import("./query-match");
          const columns = idx.columns;
          const requestedColumns = extractRequestedColumns(query, columns);

          // Try vector search first; fall back to keyword scan when embeddings
          // are unavailable (402/429) OR when the RPC returns zero matches
          // (missing/mismatched embeddings for this sheet). Guarantees the
          // model always gets rows so it never refuses on a valid selected sheet.
          let matches: Array<{ row_index: number; similarity?: number }> = [];
          let mode: "vector" | "keyword" | "keyword-partial" | "recent" = "vector";
          if (requestedColumns.length === 0) {
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
          }

          if (matches.length === 0) {
            mode = "keyword";
            const strict = data.strictMatch === true;
            const basePhrases = strictPhrases(query);
            const tokens = contentTokens(query);
            const requestedColumnNorms = new Set(
              requestedColumns.map((c) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
            );
            const searchBasePhrases = basePhrases.filter((p) => !requestedColumnNorms.has(p));
            const phrases = strict && searchBasePhrases.length === 0 && tokens.length >= 1
              ? [tokens.join(" ")]
              : searchBasePhrases;
            const hasSpecificTarget = phrases.length > 0;
            const scored = rows.map((r) => {
              const values = requestedColumns.length > 0 ? requestedColumns.map((col) => r.data[col]) : Object.values(r.data);
              const hay = normalizeHaystack(values);
              if (phrases.length > 0) {
                if (!matchesAllPhrases(hay, phrases)) return { row_index: r.row_index, similarity: 0 };
                return { row_index: r.row_index, similarity: 10 + tokens.length };
              }
              if (tokens.length > 0 && !tokens.every((t) => hay.includes(t))) {
                return { row_index: r.row_index, similarity: 0 };
              }
              return { row_index: r.row_index, similarity: tokens.length };
            });
            scored.sort((a, b) => b.similarity - a.similarity);
            let anyHit = scored.some((s) => s.similarity > 0);
            if (anyHit) {
              matches = scored.filter((s) => s.similarity > 0).slice(0, k);
            } else if (phrases.length > 0) {
              // Fuzzy fallback for name-like phrases (typos, initials,
              // "Arpita D" vs "Arpita Das"). Strict remains the default;
              // we only reach here when strict returned zero rows.
              const { matchesAllPhrasesFuzzy } = await import("./query-match");
              const { fuzzyNameInText } = await import("./person-resolver");
              const fuzzyScored = rows
                .map((r) => {
                  const values = requestedColumns.length > 0 ? requestedColumns.map((col) => r.data[col]) : Object.values(r.data);
                  const hay = normalizeHaystack(values);
                  return {
                    row_index: r.row_index,
                    similarity: matchesAllPhrasesFuzzy(hay, phrases, fuzzyNameInText) ? 5 : 0,
                  };
                })
                .filter((s) => s.similarity > 0)
                .slice(0, k);
              if (fuzzyScored.length > 0) {
                matches = fuzzyScored;
                mode = "keyword-partial";
                anyHit = true;
              }
            }
            if (anyHit) {
              // matches already set above
            } else if (!strict && phrases.length >= 2) {

              // Graceful "partial match": rank rows by how many strict
              // phrases hit. Prevents hard-fail lookups when the sheet
              // stores a name slightly differently (extra initial, spaces,
              // different casing across columns).
              const partial = rows
                .map((r) => ({
                  row_index: r.row_index,
                  similarity: countPhraseHits(
                    normalizeHaystack(requestedColumns.length > 0 ? requestedColumns.map((col) => r.data[col]) : Object.values(r.data)),
                    phrases,
                  ),
                }))
                .filter((s) => s.similarity > 0)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, k);
              matches = partial;
              if (partial.length > 0) mode = "keyword-partial";
              else matches = [];
            } else if (strict || hasSpecificTarget || tokens.length >= 1) {
              matches = [];
            } else {
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
            _summary: `${results.length} rows from "${reg.display_name}" (${mode}${requestedColumns.length ? `, searched columns: ${requestedColumns.join(", ")}` : ""})`,
            _resultForModel: { sheet: reg.display_name, mode, searched_columns: requestedColumns, matches: results },
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
          const idx = await getSheetIndexCached(sheet_id);
          const rows = idx.rows;
          const num = typeof value === "number" ? value : Number(value);
          const numeric = ["gt", "gte", "lt", "lte"].includes(op);
          const s = String(value).toLowerCase().trim();
          const matches: Array<{ row_index: number; data: Record<string, unknown> }> = [];

          // Fast path: eq via valuePostings (O(1) lookup instead of full scan).
          if (op === "eq") {
            const colMap = idx.valuePostings.get(column);
            const hits = colMap?.get(s) ?? [];
            for (const ri of hits) {
              matches.push({ row_index: ri, data: idx.byIndex.get(ri) ?? {} });
              if (matches.length >= limit) break;
            }
          } else if (numeric) {
            // Fast path: binary-search the sorted numeric list.
            const nums = idx.numericByColumn.get(column) ?? [];
            if (Number.isFinite(num) && nums.length > 0) {
              for (const { n, row_index } of nums) {
                let hit = false;
                if (op === "gt") hit = n > num;
                else if (op === "gte") hit = n >= num;
                else if (op === "lt") hit = n < num;
                else if (op === "lte") hit = n <= num;
                if (hit) {
                  matches.push({ row_index, data: idx.byIndex.get(row_index) ?? {} });
                  if (matches.length >= limit) break;
                }
              }
            }
          } else {
            // neq / contains — must visit every row in that column
            for (const r of rows) {
              const v = r.data[column];
              if (v == null) continue;
              const sv = String(v).toLowerCase();
              let hit = false;
              if (op === "neq") hit = sv !== s;
              else if (op === "contains") hit = sv.includes(s);
              if (hit) {
                matches.push(r);
                if (matches.length >= limit) break;
              }
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

    const distinctValues = tool({
      description:
        "List the distinct values of a column with counts (top 50). Use to explore what values exist — statuses, people, stages, categories — before filtering.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        column: z.string().min(1).max(120),
      }),
      execute: async ({ sheet_id, column }) =>
        withTrace("distinct_values", { sheet_id, column }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const counts = new Map<string, number>();
          for (const r of rows) {
            const v = r.data[column];
            if (v == null || v === "") continue;
            const key = String(v).slice(0, 200);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const out = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 50)
            .map(([value, count]) => ({ value, count }));
          return {
            _summary: `${out.length} distinct values in ${column}`,
            _resultForModel: { sheet: reg.display_name, column, distinct_count: counts.size, top: out },
          };
        }),
    });

    const countWhere = tool({
      description:
        "Count rows in a sheet matching one or more (column op value) conditions. Use match='any' for OR questions such as 'Store or Contractor column'; use match='all' for AND filters.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        match: z.enum(["all", "any"]).default("all"),
        conditions: z
          .array(
            z.object({
              column: z.string().min(1).max(120),
              op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "blank", "not_blank"]),
              value: z.union([z.string(), z.number(), z.boolean()]).optional(),
            }),
          )
          .min(1)
          .max(6),
      }),
      execute: async ({ sheet_id, match, conditions }) =>
        withTrace("count_where", { sheet_id, match, conditions }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          const columns = rowColumns(rows);
          const conditionMatches = (r: { data: Record<string, unknown> }, c: (typeof conditions)[number]) => {
            const key = resolveColumn(c.column, columns);
            if (!key) return false;
            const v = r.data[key];
            const isBlank = v == null || v === "";
            if (c.op === "blank") return isBlank;
            if (c.op === "not_blank") return !isBlank;
            if (isBlank) return false;
            const numeric = ["gt", "gte", "lt", "lte"].includes(c.op);
            if (numeric) {
              const nv = Number(v);
              const nq = Number(c.value);
              if (!Number.isFinite(nv) || !Number.isFinite(nq)) return false;
              if (c.op === "gt") return nv > nq;
              if (c.op === "gte") return nv >= nq;
              if (c.op === "lt") return nv < nq;
              if (c.op === "lte") return nv <= nq;
            } else {
              const sv = String(v).toLowerCase();
              const sq = String(c.value ?? "").toLowerCase();
              if (c.op === "eq") return sv === sq;
              if (c.op === "neq") return sv !== sq;
              if (c.op === "contains") return sv.includes(sq);
            }
            return false;
          };
          let n = 0;
          for (const r of rows) {
            const ok = match === "any"
              ? conditions.some((c) => conditionMatches(r, c))
              : conditions.every((c) => conditionMatches(r, c));
            if (ok) n++;
          }
          return {
            _summary: `${n} of ${rows.length} rows match`,
            _resultForModel: { sheet: reg.display_name, matched: n, total: rows.length, match, conditions },
          };
        }),
    });

    const findAcrossSheets = tool({
      description:
        "Search a phrase across ALL selected sheets in parallel. Use for cross-sheet lookups like a name/ID/keyword that could live in any source. Returns up to k top rows per sheet.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        k_per_sheet: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, k_per_sheet }) =>
        withTrace("find_across_sheets", { query, k_per_sheet }, async () => {
          const { strictPhrases, normalizeHaystack, matchesAllPhrases, contentTokens } =
            await import("./query-match");
          const phrases = strictPhrases(query);
          const tokens = contentTokens(query);
          const per: Array<{ sheet: string; hits: Array<{ row_index: number; data: Record<string, unknown>; cite: string }> }> = [];
          for (const r of regs) {
            const rows = await getSheetRows(r.id);
            const scored: Array<{ row_index: number; score: number; data: Record<string, unknown> }> = [];
            for (const row of rows) {
              const hay = normalizeHaystack(Object.values(row.data));
              let score = 0;
              if (phrases.length > 0) {
                if (matchesAllPhrases(hay, phrases)) score = 10 + tokens.length;
              } else if (tokens.length > 0 && tokens.every((t) => hay.includes(t))) {
                score = tokens.length;
              }
              if (score > 0) scored.push({ row_index: row.row_index, score, data: row.data });
            }
            scored.sort((a, b) => b.score - a.score);
            const hits = scored.slice(0, k_per_sheet).map((s) => {
              ledger.push({ kind: "sheet_row", registryId: r.id, sheetLabel: r.display_name, rowIndex: s.row_index, data: s.data });
              return { row_index: s.row_index, data: s.data, cite: `[sheet:${r.display_name} row ${s.row_index + 1}]` };
            });
            if (hits.length) per.push({ sheet: r.display_name, hits });
          }
          const total = per.reduce((a, b) => a + b.hits.length, 0);
          return {
            _summary: `${total} rows across ${per.length} sheet(s)`,
            _resultForModel: { query, matches_by_sheet: per },
          };
        }),
    });

    // ============ ANALYTICS: trends, bottlenecks, forecasts ============

    const terminalRx = /^(done|closed|complete|completed|finished|delivered|cancelled|canceled|dispatched|received|handover|handed over)$/i;

    const trendAnalyze = tool({
      description:
        "Analyze a sheet over time: week-over-week / month-over-month volume, mean & median duration, and simple anomaly flags (weeks whose count is >2x or <0.5x the rolling median). Use for 'trend', 'is it improving', 'how has X changed', 'anomalies/spikes', 'week over week', 'month over month' questions.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        date_column: z.string().min(1).max(120).nullable().default(null).describe("Date column to bucket on. Auto-detected if omitted."),
        bucket: z.enum(["week", "month"]).default("week"),
        lookback_buckets: z.number().int().min(2).max(52).default(8),
      }),
      execute: async ({ sheet_id, date_column, bucket, lookback_buckets }) =>
        withTrace("trend_analyze", { sheet_id, date_column, bucket, lookback_buckets }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          if (rows.length === 0) return { _summary: "empty sheet", _resultForModel: { sheet: reg.display_name, buckets: [] } };
          let dateCol = date_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === date_column.toLowerCase().trim()) ?? null
            : null;
          if (!dateCol) dateCol = pickDateColumns(rows, null)[0] ?? null;
          if (!dateCol) return { error: "No date-like column detected; pass date_column." };
          const bucketMs = bucket === "week" ? 7 * 86400000 : 30 * 86400000;
          const now = Date.now();
          const oldest = now - lookback_buckets * bucketMs;
          const buckets = new Map<number, number>();
          for (const r of rows) {
            const d = parseAnyDate(r.data[dateCol]);
            if (!d) continue;
            const t = +d;
            if (t < oldest || t > now) continue;
            const key = Math.floor((now - t) / bucketMs);
            buckets.set(key, (buckets.get(key) ?? 0) + 1);
          }
          const series: Array<{ bucket: string; count: number; anomaly: string | null }> = [];
          const counts: number[] = [];
          for (let i = lookback_buckets - 1; i >= 0; i--) counts.push(buckets.get(i) ?? 0);
          const sorted = [...counts].sort((a, b) => a - b);
          const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
          for (let i = 0; i < counts.length; i++) {
            const idx = lookback_buckets - 1 - i;
            const startMs = now - (idx + 1) * bucketMs;
            const label = new Date(startMs).toISOString().slice(0, 10);
            let anomaly: string | null = null;
            if (median > 0) {
              if (counts[i] > 2 * median) anomaly = `spike (${counts[i]} vs median ${median})`;
              else if (counts[i] < 0.5 * median) anomaly = `dip (${counts[i]} vs median ${median})`;
            }
            series.push({ bucket: `${bucket} starting ${label}`, count: counts[i], anomaly });
          }
          const first = counts[0] ?? 0;
          const last = counts[counts.length - 1] ?? 0;
          const delta = last - first;
          const pct = first > 0 ? Math.round(((last - first) / first) * 100) : null;
          const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
          return {
            _summary: `${lookback_buckets} ${bucket}s, trend ${direction}${pct !== null ? ` (${pct}%)` : ""}`,
            _resultForModel: {
              sheet: reg.display_name,
              date_column: dateCol,
              bucket,
              median_per_bucket: median,
              first_bucket_count: first,
              last_bucket_count: last,
              direction,
              percent_change: pct,
              series,
            },
          };
        }),
    });

    const bottleneckScan = tool({
      description:
        "Find the top bottlenecks in a sheet: which values of a grouping column (stage / status / owner / vendor / department) contain the largest share of open/overdue/long-aging rows. Use for 'where are we stuck', 'who is the bottleneck', 'which stage delays most', 'top blockers'.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        group_by: z.string().min(1).max(120).describe("Column to group by (e.g. 'Stage', 'Owner', 'Vendor', 'Department')."),
        date_column: z.string().min(1).max(120).nullable().default(null).describe("Aging date column; auto-detected if omitted."),
        status_column: z.string().max(120).nullable().default(null),
        top_n: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ sheet_id, group_by, date_column, status_column, top_n }) =>
        withTrace("bottleneck_scan", { sheet_id, group_by, date_column, status_column, top_n }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          if (rows.length === 0) return { _summary: "empty sheet", _resultForModel: { sheet: reg.display_name, groups: [] } };
          const groupKey = Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === group_by.toLowerCase().trim());
          if (!groupKey) return { error: `Column "${group_by}" not found. Call get_sheet_schema.` };
          const dateCol = date_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === date_column.toLowerCase().trim()) ?? null
            : pickDateColumns(rows, null)[0] ?? null;
          const statusKey = status_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === status_column.toLowerCase().trim())
            : Object.keys(rows[0]?.data ?? {}).find((k) => /status|stage|state/i.test(k));
          const now = Date.now();
          const groups = new Map<string, { open: number; overdue: number; total_age_days: number; sample_rows: number[] }>();
          for (const r of rows) {
            const g = String(r.data[groupKey] ?? "").trim();
            if (!g) continue;
            const status = statusKey ? String(r.data[statusKey] ?? "").trim() : "";
            const isTerminal = status && terminalRx.test(status);
            const d = dateCol ? parseAnyDate(r.data[dateCol]) : null;
            const ageDays = d ? Math.max(0, Math.floor((now - +d) / 86400000)) : 0;
            const cur = groups.get(g) ?? { open: 0, overdue: 0, total_age_days: 0, sample_rows: [] };
            if (!isTerminal) {
              cur.open += 1;
              cur.total_age_days += ageDays;
              if (d && +d < now) cur.overdue += 1;
              if (cur.sample_rows.length < 3) cur.sample_rows.push(r.row_index);
            }
            groups.set(g, cur);
          }
          const ranked = Array.from(groups.entries())
            .map(([value, s]) => ({
              value,
              open: s.open,
              overdue: s.overdue,
              avg_age_days: s.open > 0 ? Math.round(s.total_age_days / s.open) : 0,
              sample_row_citations: s.sample_rows.map((idx) => {
                const row = rows.find((rr) => rr.row_index === idx);
                if (row) ledger.push({ kind: "sheet_row", registryId: sheet_id, sheetLabel: reg.display_name, rowIndex: idx, data: row.data });
                return `[sheet:${reg.display_name} row ${idx + 1}]`;
              }),
            }))
            .filter((g) => g.open > 0)
            .sort((a, b) => b.overdue - a.overdue || b.open - a.open || b.avg_age_days - a.avg_age_days)
            .slice(0, top_n);
          return {
            _summary: `top ${ranked.length} ${group_by} bottlenecks`,
            _resultForModel: { sheet: reg.display_name, group_by: groupKey, date_column: dateCol, status_column: statusKey ?? null, bottlenecks: ranked },
          };
        }),
    });

    const forecastCompletion = tool({
      description:
        "Forecast when a sheet's remaining open items will complete, based on recent throughput. Computes: open count, completions in the last N days, per-day rate, projected days-to-clear, projected clear date, and simple slip probability vs a target date. Use for 'when will we finish', 'ETA', 'are we on track', 'will we hit <date>', 'projected completion'.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        status_column: z.string().max(120).nullable().default(null),
        completion_date_column: z.string().max(120).nullable().default(null).describe("Column holding the completion date (e.g. 'Dispatch Date', 'Delivered On'). Auto-detected if omitted."),
        target_date: z.string().nullable().default(null).describe("Optional ISO target/deadline to compute slip probability."),
        lookback_days: z.number().int().min(3).max(180).default(30),
      }),
      execute: async ({ sheet_id, status_column, completion_date_column, target_date, lookback_days }) =>
        withTrace("forecast_completion", { sheet_id, status_column, completion_date_column, target_date, lookback_days }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          if (rows.length === 0) return { _summary: "empty sheet", _resultForModel: { sheet: reg.display_name } };
          const statusKey = status_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === status_column.toLowerCase().trim())
            : Object.keys(rows[0]?.data ?? {}).find((k) => /status|stage|state/i.test(k));
          if (!statusKey) return { error: "No status column found; pass status_column." };
          const doneCol = completion_date_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === completion_date_column.toLowerCase().trim()) ?? null
            : Object.keys(rows[0]?.data ?? {}).find((k) => /(dispatch|deliver|complete|closed|done|handover|received)/i.test(k)) ?? null;
          const now = Date.now();
          const windowStart = now - lookback_days * 86400000;
          let openCount = 0;
          let completedInWindow = 0;
          let totalCompleted = 0;
          for (const r of rows) {
            const status = String(r.data[statusKey] ?? "").trim();
            const isTerminal = status && terminalRx.test(status);
            if (isTerminal) {
              totalCompleted += 1;
              if (doneCol) {
                const d = parseAnyDate(r.data[doneCol]);
                if (d && +d >= windowStart && +d <= now) completedInWindow += 1;
              }
            } else {
              openCount += 1;
            }
          }
          const perDay = completedInWindow / lookback_days;
          const daysToClear = perDay > 0 ? Math.ceil(openCount / perDay) : null;
          const projectedClearISO = daysToClear !== null ? new Date(now + daysToClear * 86400000).toISOString().slice(0, 10) : null;
          let slip: null | { target: string; days_available: number; days_needed: number | null; slip_probability: string; verdict: string } = null;
          if (target_date) {
            const tgt = parseAnyDate(target_date);
            if (tgt) {
              const daysAvail = Math.max(0, Math.ceil((+tgt - now) / 86400000));
              let prob = "unknown";
              let verdict = "insufficient throughput data";
              if (daysToClear !== null) {
                const ratio = daysAvail > 0 ? daysToClear / daysAvail : 99;
                if (ratio <= 0.75) { prob = "low"; verdict = "on track"; }
                else if (ratio <= 1.0) { prob = "medium"; verdict = "tight — likely to just meet target"; }
                else if (ratio <= 1.5) { prob = "high"; verdict = "likely to slip"; }
                else { prob = "very high"; verdict = "very likely to miss target"; }
              }
              slip = { target: tgt.toISOString().slice(0, 10), days_available: daysAvail, days_needed: daysToClear, slip_probability: prob, verdict };
            }
          }
          return {
            _summary: `${openCount} open, ${perDay.toFixed(2)}/day pace, ETA ${projectedClearISO ?? "n/a"}`,
            _resultForModel: {
              sheet: reg.display_name,
              status_column: statusKey,
              completion_date_column: doneCol,
              open_count: openCount,
              total_completed: totalCompleted,
              completed_last_n_days: completedInWindow,
              lookback_days,
              per_day_completion_rate: Number(perDay.toFixed(3)),
              projected_days_to_clear: daysToClear,
              projected_clear_date: projectedClearISO,
              vs_target: slip,
              note: perDay === 0 ? "No completions in lookback window — cannot forecast; expand lookback_days or check completion_date_column." : null,
            },
          };
        }),
    });

    // ============ COMPARISONS / BENCHMARKS ============

    const compareGroups = tool({
      description:
        "Benchmark two or more entities against each other. Two modes: (a) intra-sheet — compare specific values of a grouping column in ONE sheet (e.g. compare owners 'A' vs 'B', or stages 'Design' vs 'Procurement'); (b) cross-sheet — compare the same metric across MULTIPLE sheets (pass sheet_ids, leave group_by/values empty). Returns per-group counts, open/overdue counts, avg age (days), completion rate %, and sample row citations. Use for 'compare X vs Y', 'benchmark', 'who's doing better', 'which sheet/team/vendor is faster', 'difference between'.",
      inputSchema: z.object({
        sheet_id: z.string().uuid().nullable().default(null).describe("Sheet for intra-sheet comparison. Leave null for cross-sheet mode."),
        group_by: z.string().min(1).max(120).nullable().default(null).describe("Column to group by (intra-sheet mode)."),
        values: z.array(z.string().min(1).max(200)).max(8).default([]).describe("Specific values of group_by to compare (intra-sheet mode). Empty = top 5 groups by row count."),
        sheet_ids: z.array(z.string().uuid()).max(6).default([]).describe("Sheets to compare against each other (cross-sheet mode)."),
        date_column: z.string().max(120).nullable().default(null).describe("Aging date column; auto-detected if omitted."),
        status_column: z.string().max(120).nullable().default(null),
      }),
      execute: async ({ sheet_id, group_by, values, sheet_ids, date_column, status_column }) =>
        withTrace("compare_groups", { sheet_id, group_by, values, sheet_ids, date_column, status_column }, async () => {
          const now = Date.now();
          type Stat = { label: string; total: number; open: number; overdue: number; completed: number; avg_age_days: number; completion_rate_pct: number; sample_row_citations: string[] };

          const statForRows = (
            label: string,
            rowsIn: Array<{ row_index: number; data: Record<string, unknown> }>,
            registryId: string,
            sheetLabel: string,
            dateCol: string | null,
            statusKey: string | undefined | null,
          ): Stat => {
            let open = 0, overdue = 0, completed = 0, ageSum = 0, ageCount = 0;
            const samples: number[] = [];
            for (const r of rowsIn) {
              const status = statusKey ? String(r.data[statusKey] ?? "").trim() : "";
              const isTerminal = status && terminalRx.test(status);
              const d = dateCol ? parseAnyDate(r.data[dateCol]) : null;
              if (isTerminal) completed += 1;
              else {
                open += 1;
                if (d) {
                  const age = Math.max(0, Math.floor((now - +d) / 86400000));
                  ageSum += age; ageCount += 1;
                  if (+d < now) overdue += 1;
                }
                if (samples.length < 3) samples.push(r.row_index);
              }
            }
            for (const idx of samples) {
              const row = rowsIn.find((rr) => rr.row_index === idx);
              if (row) ledger.push({ kind: "sheet_row", registryId, sheetLabel, rowIndex: idx, data: row.data });
            }
            return {
              label,
              total: rowsIn.length,
              open,
              overdue,
              completed,
              avg_age_days: ageCount > 0 ? Math.round(ageSum / ageCount) : 0,
              completion_rate_pct: rowsIn.length > 0 ? Math.round((completed / rowsIn.length) * 100) : 0,
              sample_row_citations: samples.map((idx) => `[sheet:${sheetLabel} row ${idx + 1}]`),
            };
          };

          // Cross-sheet mode
          if (!sheet_id && sheet_ids.length >= 2) {
            const results: Stat[] = [];
            for (const sid of sheet_ids) {
              const reg = sheetById.get(sid);
              if (!reg) continue;
              const rows = await getSheetRows(sid);
              if (rows.length === 0) { results.push({ label: reg.display_name, total: 0, open: 0, overdue: 0, completed: 0, avg_age_days: 0, completion_rate_pct: 0, sample_row_citations: [] }); continue; }
              const dateCol = date_column
                ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === date_column.toLowerCase().trim()) ?? null
                : pickDateColumns(rows, null)[0] ?? null;
              const statusKey = status_column
                ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === status_column.toLowerCase().trim())
                : Object.keys(rows[0]?.data ?? {}).find((k) => /status|stage|state/i.test(k));
              results.push(statForRows(reg.display_name, rows, sid, reg.display_name, dateCol, statusKey));
            }
            return {
              _summary: `cross-sheet compare of ${results.length} sheets`,
              _resultForModel: { mode: "cross_sheet", groups: results },
            };
          }

          // Intra-sheet mode
          if (!sheet_id || !group_by) return { error: "Provide sheet_id + group_by for intra-sheet compare, or sheet_ids (>=2) for cross-sheet compare." };
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          if (rows.length === 0) return { _summary: "empty sheet", _resultForModel: { mode: "intra_sheet", sheet: reg.display_name, groups: [] } };
          const groupKey = Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === group_by.toLowerCase().trim());
          if (!groupKey) return { error: `Column "${group_by}" not found. Call get_sheet_schema.` };
          const dateCol = date_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === date_column.toLowerCase().trim()) ?? null
            : pickDateColumns(rows, null)[0] ?? null;
          const statusKey = status_column
            ? Object.keys(rows[0]?.data ?? {}).find((k) => k.toLowerCase().trim() === status_column.toLowerCase().trim())
            : Object.keys(rows[0]?.data ?? {}).find((k) => /status|stage|state/i.test(k));

          const byVal = new Map<string, Array<{ row_index: number; data: Record<string, unknown> }>>();
          for (const r of rows) {
            const v = String(r.data[groupKey] ?? "").trim();
            if (!v) continue;
            const arr = byVal.get(v) ?? [];
            arr.push(r);
            byVal.set(v, arr);
          }
          let targets: string[];
          if (values.length > 0) {
            const norm = (s: string) => s.toLowerCase().trim();
            const availByNorm = new Map(Array.from(byVal.keys()).map((k) => [norm(k), k]));
            targets = values.map((v) => availByNorm.get(norm(v))).filter((x): x is string => !!x);
            const missing = values.filter((v) => !availByNorm.has(norm(v)));
            if (targets.length === 0) {
              return { error: `None of the requested values found in column "${groupKey}". Available: ${Array.from(byVal.keys()).slice(0, 15).join(", ")}` };
            }
            const results = targets.map((t) => statForRows(t, byVal.get(t) ?? [], sheet_id, reg.display_name, dateCol, statusKey));
            return {
              _summary: `intra-sheet compare of ${results.length} groups on ${groupKey}`,
              _resultForModel: { mode: "intra_sheet", sheet: reg.display_name, group_by: groupKey, date_column: dateCol, status_column: statusKey ?? null, groups: results, missing_values: missing },
            };
          }
          targets = Array.from(byVal.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([k]) => k);
          const results = targets.map((t) => statForRows(t, byVal.get(t) ?? [], sheet_id, reg.display_name, dateCol, statusKey));
          return {
            _summary: `intra-sheet compare of top ${results.length} groups on ${groupKey}`,
            _resultForModel: { mode: "intra_sheet", sheet: reg.display_name, group_by: groupKey, date_column: dateCol, status_column: statusKey ?? null, groups: results },
          };
        }),
    });

    // ============ EXPLAIN-WHY: root-cause a specific row/entity ============

    const explainWhy = tool({
      description:
        "Root-cause analysis for ONE specific row / entity. Answers 'why is X delayed/stuck/slow'. Given a row_index (or a search query that resolves to one row), returns: current stage/status, aging days, any explicit delay-reason field, siblings stuck at the same stage, and how this row compares to the group's median age. Use whenever the user asks 'why', 'what's blocking', 'reason for delay', 'what's holding X up'.",
      inputSchema: z.object({
        sheet_id: z.string().uuid(),
        row_index: z.number().int().min(0).nullable().default(null).describe("Zero-based row index (from get_row or previous search). Preferred."),
        query: z.string().min(1).max(300).nullable().default(null).describe("Fallback: identifier / name to locate the row if row_index is unknown."),
      }),
      execute: async ({ sheet_id, row_index, query }) =>
        withTrace("explain_why", { sheet_id, row_index, query }, async () => {
          const reg = sheetById.get(sheet_id);
          if (!reg) return { error: "Unknown sheet_id" };
          const rows = await getSheetRows(sheet_id);
          if (rows.length === 0) return { _summary: "empty sheet", _resultForModel: { sheet: reg.display_name } };

          let target = row_index !== null ? rows.find((r) => r.row_index === row_index) : null;
          if (!target && query) {
            const q = query.toLowerCase().trim();
            target = rows.find((r) => Object.values(r.data).some((v) => String(v ?? "").toLowerCase().includes(q))) ?? null;
          }
          if (!target) return { error: "Row not found. Pass row_index or a query that uniquely identifies the row." };

          const cols = Object.keys(target.data);
          const statusKey = cols.find((k) => /status|stage|state/i.test(k));
          const reasonKey = cols.find((k) => /(reason|remark|note|comment|blocker|blocked|hold|delay(_| )?cause|root(_| )?cause|pending(_| )?for)/i.test(k));
          const ownerKey = cols.find((k) => /(owner|responsible|assignee|assigned(_| )?to|dept|department|vendor)/i.test(k));
          const dateCol = pickDateColumns(rows, null)[0] ?? null;

          const now = Date.now();
          const targetDate = dateCol ? parseAnyDate(target.data[dateCol]) : null;
          const targetAge = targetDate ? Math.max(0, Math.floor((now - +targetDate) / 86400000)) : null;
          const targetStatus = statusKey ? String(target.data[statusKey] ?? "").trim() : "";
          const targetOwner = ownerKey ? String(target.data[ownerKey] ?? "").trim() : "";
          const explicitReason = reasonKey ? String(target.data[reasonKey] ?? "").trim() : "";
          const isTerminal = targetStatus && terminalRx.test(targetStatus);

          // Siblings stuck at the same stage (open only)
          const siblings: Array<{ row_index: number; age_days: number }> = [];
          const stageAges: number[] = [];
          if (statusKey && targetStatus) {
            for (const r of rows) {
              if (r.row_index === target.row_index) continue;
              const s = String(r.data[statusKey] ?? "").trim();
              if (s.toLowerCase() !== targetStatus.toLowerCase()) continue;
              const isDone = terminalRx.test(s);
              if (isDone) continue;
              const d = dateCol ? parseAnyDate(r.data[dateCol]) : null;
              const age = d ? Math.max(0, Math.floor((now - +d) / 86400000)) : 0;
              stageAges.push(age);
              if (siblings.length < 5) siblings.push({ row_index: r.row_index, age_days: age });
            }
          }
          const stageMedianAge = stageAges.length
            ? [...stageAges].sort((a, b) => a - b)[Math.floor(stageAges.length / 2)]
            : null;

          // Cite target + siblings
          ledger.push({ kind: "sheet_row", registryId: sheet_id, sheetLabel: reg.display_name, rowIndex: target.row_index, data: target.data });
          const siblingCites: string[] = [];
          for (const sib of siblings) {
            const row = rows.find((rr) => rr.row_index === sib.row_index);
            if (row) ledger.push({ kind: "sheet_row", registryId: sheet_id, sheetLabel: reg.display_name, rowIndex: sib.row_index, data: row.data });
            siblingCites.push(`[sheet:${reg.display_name} row ${sib.row_index + 1}]`);
          }

          // Compose likely causes
          const causes: string[] = [];
          if (explicitReason) causes.push(`Explicit reason in "${reasonKey}": "${explicitReason}"`);
          if (isTerminal) causes.push(`Row is already terminal (status="${targetStatus}") — no active blocker.`);
          if (!explicitReason && targetStatus && !isTerminal) causes.push(`Stuck at stage "${targetStatus}"${targetOwner ? ` under owner "${targetOwner}"` : ""}.`);
          if (stageMedianAge !== null && targetAge !== null) {
            if (targetAge > stageMedianAge * 1.5 && targetAge - stageMedianAge >= 3) causes.push(`Aged ${targetAge}d vs stage median ${stageMedianAge}d — running ${targetAge - stageMedianAge}d longer than peers.`);
            else if (targetAge < stageMedianAge * 0.5) causes.push(`Aged ${targetAge}d vs stage median ${stageMedianAge}d — younger than peers; likely just entered this stage.`);
          }
          if (siblings.length >= 3) causes.push(`Systemic — ${siblings.length + 1} rows stuck at same stage "${targetStatus}", suggesting a stage-level bottleneck rather than a per-row issue.`);
          if (causes.length === 0) causes.push("No explicit blocker field or stage anomaly detected. Consider asking the owner directly.");

          return {
            _summary: `explain row ${target.row_index + 1}: ${causes[0].slice(0, 80)}`,
            _resultForModel: {
              sheet: reg.display_name,
              row_citation: `[sheet:${reg.display_name} row ${target.row_index + 1}]`,
              status_column: statusKey ?? null,
              current_status: targetStatus || null,
              owner_column: ownerKey ?? null,
              owner: targetOwner || null,
              date_column: dateCol,
              age_days: targetAge,
              is_terminal: !!isTerminal,
              explicit_reason_column: reasonKey ?? null,
              explicit_reason: explicitReason || null,
              stage_peer_count: stageAges.length,
              stage_median_age_days: stageMedianAge,
              sibling_row_citations: siblingCites,
              likely_causes: causes,
            },
          };
        }),
    });

    // ============ CROSS-SOURCE: join sheets↔sheets and sheets↔docs ============

    const crossReference = tool({
      description:
        "Look up a single identifier or proper-noun (PO#, GSTIN, invoice#, project code, person's full name) across EVERY selected sheet AND document in parallel. Returns per-source matches so you can join facts spanning multiple sources (e.g. 'PO in sheet X → clause in contract doc Y'). Use whenever the user asks about a specific entity without naming a source, or when a question requires stitching facts from >1 source.",
      inputSchema: z.object({
        key: z.string().min(1).max(200).describe("The exact identifier or name to look for."),
        k_per_source: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ key, k_per_source }) =>
        withTrace("cross_reference", { key, k_per_source }, async () => {
          const needle = key.toLowerCase().trim();
          const sheetHits = await Promise.all(
            regs.map(async (r) => {
              try {
                const rows = await getSheetRows(r.id);
                const matched = rows
                  .filter((row) =>
                    Object.values(row.data).some((v) => String(v ?? "").toLowerCase().includes(needle)),
                  )
                  .slice(0, k_per_source);
                for (const row of matched) {
                  ledger.push({
                    kind: "sheet_row",
                    registryId: r.id,
                    sheetLabel: r.display_name,
                    rowIndex: row.row_index,
                    data: row.data,
                  });
                }
                return {
                  sheet: r.display_name,
                  hits: matched.map((row) => ({
                    row_index: row.row_index,
                    preview: stringifyRow(row.data).slice(0, 300),
                    cite: `[sheet:${r.display_name} row ${row.row_index + 1}]`,
                  })),
                };
              } catch {
                return { sheet: r.display_name, hits: [] };
              }
            }),
          );
          const docHits = await Promise.all(
            docs.map(async (d) => {
              try {
                const { data: chunks } = await supabase
                  .from("document_chunks")
                  .select("document_id, content, page_no")
                  .eq("document_id", d.id)
                  .limit(300);
                const matched = ((chunks ?? []) as any[])
                  .filter((c) => String(c.content ?? "").toLowerCase().includes(needle))
                  .slice(0, k_per_source);
                for (const c of matched) {
                  ledger.push({
                    kind: "doc_chunk",
                    documentId: d.id,
                    documentName: d.name,
                    pageNo: c.page_no ?? 0,
                    snippet: c.content ?? "",
                  });
                }
                return {
                  document: d.name,
                  hits: matched.map((c) => ({
                    page: c.page_no ?? 0,
                    snippet: String(c.content ?? "").slice(0, 300),
                    cite: `[doc:${d.name} p.${c.page_no ?? 0}]`,
                  })),
                };
              } catch {
                return { document: d.name, hits: [] };
              }
            }),
          );
          const totalHits =
            sheetHits.reduce((n, s) => n + s.hits.length, 0) + docHits.reduce((n, d) => n + d.hits.length, 0);
          return {
            _summary: `"${key}" → ${totalHits} matches across ${sheetHits.length} sheet(s) + ${docHits.length} doc(s)`,
            _resultForModel: { key, sheets: sheetHits, documents: docHits },
          };
        }),
    });

    const buildTimeline = tool({
      description:
        "Reconstruct a chronological timeline of events matching a keyword/entity across selected sheets. Each event = (date, sheet, row, one-line summary, cite). Use for 'what happened with X', 'timeline of PO#123', 'sequence of events', 'history of this project'.",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        max_events: z.number().int().min(3).max(60).default(30),
      }),
      execute: async ({ query, max_events }) =>
        withTrace("build_timeline", { query, max_events }, async () => {
          const needle = query.toLowerCase().trim();
          const events: Array<{ date: string; sheet: string; row_index: number; summary: string; cite: string }> = [];
          for (const r of regs) {
            try {
              const rows = await getSheetRows(r.id);
              if (!rows.length) continue;
              const dateCols = pickDateColumns(rows, null);
              const matched = rows.filter((row) =>
                Object.values(row.data).some((v) => String(v ?? "").toLowerCase().includes(needle)),
              );
              for (const row of matched) {
                for (const dc of dateCols.slice(0, 3)) {
                  const d = parseAnyDate(row.data[dc]);
                  if (!d) continue;
                  ledger.push({
                    kind: "sheet_row",
                    registryId: r.id,
                    sheetLabel: r.display_name,
                    rowIndex: row.row_index,
                    data: row.data,
                  });
                  events.push({
                    date: d.toISOString().slice(0, 10),
                    sheet: r.display_name,
                    row_index: row.row_index,
                    summary: `${dc}: ${stringifyRow(row.data).slice(0, 180)}`,
                    cite: `[sheet:${r.display_name} row ${row.row_index + 1} col ${dc}]`,
                  });
                }
              }
            } catch { /* skip */ }
          }
          events.sort((a, b) => a.date.localeCompare(b.date));
          const trimmed = events.slice(0, max_events);
          return {
            _summary: `${trimmed.length} timeline event(s) for "${query}"`,
            _resultForModel: { query, events: trimmed },
          };
        }),
    });

    // ============ WORKFLOWS: escalation email + scheduled reminder ============

    const draftEscalation = tool({
      description:
        "Draft an ESCALATION email (higher urgency than draft_email) into the Agent Inbox for review. Use when the user asks to escalate, chase, or escalate to management. Never sends directly — user approves in inbox.",
      inputSchema: z.object({
        subject: z.string().min(2).max(200),
        body: z.string().min(2).max(6000),
        recipient_email: z.string().email().optional(),
        severity: z.enum(["low", "med", "high", "critical"]).default("high"),
        why: z.string().max(500).optional().describe("One-line rationale with citations."),
      }),
      execute: async ({ subject, body, recipient_email, severity, why }) =>
        withTrace("draft_escalation", { subject, recipient_email, severity }, async () => {
          const banner = `⚠️ ESCALATION (severity: ${severity.toUpperCase()})\n\n`;
          const { data: row, error } = await supabase
            .from("agent_drafts")
            .insert({
              draft_type: "escalation",
              source_kind: "copilot",
              source_key: `copilot-esc:${Date.now()}`,
              title: `[Escalation] ${subject}`.slice(0, 200),
              subject: `[Escalation] ${subject}`.slice(0, 200),
              body: banner + body,
              channel: "email",
              recipient_email: recipient_email ?? null,
              why: why ?? null,
              confidence: 0.8,
              state: "pending",
            })
            .select("id")
            .single();
          if (error) return { error: error.message };
          return {
            _summary: `Drafted ${severity} escalation "${subject.slice(0, 60)}"`,
            _resultForModel: {
              draft_id: row.id,
              url: `/agent/inbox`,
              message: "Escalation drafted. Review & approve from the Agent Inbox.",
            },
          };
        }),
    });

    const scheduleReminder = tool({
      description:
        "Schedule a follow-up REMINDER as a pending activity on a project (due on a future date). Use when the user says 'remind me', 'follow up on X next week', 'check back in N days'. Requires a project_id — call list_projects first if unknown.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        title: z.string().min(2).max(300),
        remind_on: z.string().describe("ISO date YYYY-MM-DD when the reminder is due."),
        notes: z.string().max(2000).optional(),
      }),
      execute: async ({ project_id, title, remind_on, notes }) =>
        withTrace("schedule_reminder", { project_id, title, remind_on }, async () => {
          const { data: row, error } = await supabase
            .from("activities")
            .insert({
              project_id,
              title: `⏰ Reminder: ${title}`.slice(0, 300),
              description: notes ?? null,
              due_date: remind_on,
              status: "pending",
            })
            .select("id")
            .single();
          if (error) return { error: error.message };
          return {
            _summary: `Reminder set for ${remind_on}: "${title.slice(0, 60)}"`,
            _resultForModel: {
              activity_id: row.id,
              remind_on,
              message: `Reminder scheduled. Will appear on the project's activity list.`,
            },
          };
        }),
    });

    // ============ MEMORY: personalize across turns ============

    const rememberFact = tool({
      description:
        "Persist a small personal fact / preference / focus area for THIS user across future copilot sessions. Use when the user says 'remember that…', 'my focus is…', 'I care about…', 'from now on…', or when you notice they consistently ask about the same project/person/sheet. Values are private to this user.",
      inputSchema: z.object({
        kind: z.enum(["focus", "preference", "person", "project", "note"]).default("note"),
        key: z.string().min(1).max(120).describe("Short stable key, e.g. 'primary_project' or 'reporting_style'."),
        value: z.string().min(1).max(1000),
        importance: z.number().int().min(1).max(5).default(2),
      }),
      execute: async ({ kind, key, value, importance }) =>
        withTrace("remember", { kind, key }, async () => {
          const { error } = await supabase.from("agent_memory").upsert(
            { user_id: userId, kind, key, value, importance, source: "copilot" },
            { onConflict: "user_id,kind,key" },
          );
          if (error) return { error: error.message };
          return { _summary: `Remembered ${kind}:${key}`, _resultForModel: { ok: true, kind, key } };
        }),
    });

    const recallMemory = tool({
      description:
        "Recall previously saved memory for THIS user (focus areas, preferences, favorite projects/people, past notes). Call whenever the user's question is vague ('what should I look at', 'anything I should know') or references 'my usual…'.",
      inputSchema: z.object({
        kind: z.enum(["focus", "preference", "person", "project", "note", "any"]).default("any"),
        search: z.string().max(120).nullable().default(null),
      }),
      execute: async ({ kind, search }) =>
        withTrace("recall", { kind, search }, async () => {
          let q = supabase
            .from("agent_memory")
            .select("id, kind, key, value, importance, updated_at")
            .eq("user_id", userId)
            .order("importance", { ascending: false })
            .order("updated_at", { ascending: false })
            .limit(50);
          if (kind !== "any") q = q.eq("kind", kind);
          if (search) q = q.or(`key.ilike.%${search}%,value.ilike.%${search}%`);
          const { data, error } = await q;
          if (error) return { error: error.message };
          return {
            _summary: `${data?.length ?? 0} memory item(s)`,
            _resultForModel: { memories: data ?? [] },
          };
        }),
    });

    const forgetMemory = tool({
      description: "Delete a memory item by id (from recall). Use when the user says 'forget…' or 'drop that memory'.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) =>
        withTrace("forget", { id }, async () => {
          const { error } = await supabase
            .from("agent_memory")
            .delete()
            .eq("id", id)
            .eq("user_id", userId);
          if (error) return { error: error.message };
          return { _summary: `Forgot memory ${id}`, _resultForModel: { ok: true } };
        }),
    });

    // Preload top memories into the system prompt so the model personalizes
    // without needing to call recall on every turn.
    const { data: memRows } = await supabase
      .from("agent_memory")
      .select("kind, key, value, importance")
      .eq("user_id", userId)
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(20);
    const memorySnapshot = (memRows ?? []) as Array<{ kind: string; key: string; value: string; importance: number }>;







    // Pre-compute per-sheet Auto-Insights + detected shape so the model
    // knows what kind of sheet it's looking at (payments/hr/timeline/…)
    // and which columns matter. This mirrors the same insights shown in
    // the sheet header, so Copilot answers align with Auto-Insights.
    const {
      buildSheetAutoInsights,
      detectSheetShape,
    } = await import("./auto-insights-fallback.server");
    const sheetInsightSnapshot = await Promise.all(
      regs.slice(0, 5).map(async (r) => {
        try {
          const rows = await getSheetRows(r.id);
          const cols = Array.from(
            rows.reduce((set, row) => {
              Object.keys(row.data).forEach((k) => set.add(k));
              return set;
            }, new Set<string>()),
          );
          const shape = detectSheetShape(cols);
          const { insights, questions } = buildSheetAutoInsights(
            r.display_name,
            rows.map((row) => ({ row_index: row.row_index, data: row.data })),
          );
          return {
            id: r.id,
            name: r.display_name,
            detected_shape: shape,
            columns: cols.slice(0, 30),
            rows_scanned: rows.length,
            auto_insights: insights.slice(0, 6),
            suggested_questions: questions.slice(0, 4),
          };
        } catch {
          return {
            id: r.id,
            name: r.display_name,
            detected_shape: "unknown",
            columns: [],
            rows_scanned: 0,
            auto_insights: [],
            suggested_questions: [],
          };
        }
      }),
    );

    const catalog = {
      sheets: regs.map((r) => {
        const snap = sheetInsightSnapshot.find((s) => s.id === r.id);
        return {
          id: r.id,
          name: r.display_name,
          type: r.sheet_type,
          rows: r.row_count ?? 0,
          detected_shape: snap?.detected_shape ?? "unknown",
          columns: snap?.columns ?? [],
          auto_insights: snap?.auto_insights ?? [],
          suggested_questions: snap?.suggested_questions ?? [],
        };
      }),
      documents: docs.map((d) => ({
        id: d.id,
        name: d.name,
        pages: d.page_count ?? 0,
        summary: d.summary ?? null,
      })),
    };


    const { buildCopilotSystemPrompt } = await import("./copilot-system-prompt.server");
    const system = buildCopilotSystemPrompt({
      sheetInsightSnapshot,
      catalog,
      memorySnapshot,
    });


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
      distinct_values: distinctValues,
      count_where: countWhere,
      find_across_sheets: findAcrossSheets,
      trend_analyze: trendAnalyze,
      bottleneck_scan: bottleneckScan,
      forecast_completion: forecastCompletion,
      compare_groups: compareGroups,
      explain_why: explainWhy,
      cross_reference: crossReference,
      build_timeline: buildTimeline,
      draft_escalation: draftEscalation,
      schedule_reminder: scheduleReminder,
      remember: rememberFact,
      recall: recallMemory,
      forget: forgetMemory,
    };



    async function runDeterministic(reason: string): Promise<{ text?: string }> {
      const { deterministicAnswer } = await import("./copilot-deterministic.server");
      const det = await deterministicAnswer({
        supabase,
        question: data.question,
        regs: regs.map((r) => ({ id: r.id, display_name: r.display_name })),
        docs: docs.map((d) => ({ id: d.id, name: d.name })),
        ledgerSink: ledger as any,
        strictMatch: data.strictMatch === true,
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
          text: det.answer,
        };
      }
      return { text: det.answer };
    }

    async function polishWithGemini(factualAnswer: string): Promise<string> {
      // Take a factually correct deterministic answer and ask Gemini to rewrite it
      // as clean prose while preserving every number, name, ID, and [citation]
      // exactly. If Gemini is unavailable or errors, return the raw answer.
      if (!directGeminiKey || !factualAnswer.trim()) return factualAnswer;
      try {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        const google = createGoogleGenerativeAI({ apiKey: directGeminiKey });
        const polish = await generateText({
          model: google("gemini-2.5-flash"),
          system:
            "You are an editor. Rewrite the user's draft answer so it reads clearly and concisely. " +
            "STRICT RULES: (1) Do NOT invent, add, remove, or change any number, name, ID, date, or [bracketed citation]. " +
            "(2) Keep every citation like [sheet:X row N col Y] verbatim in place. " +
            "(3) Preserve bullet lists and structure. (4) If the draft is a clarifying question or refusal, keep it as-is. " +
            "Output only the rewritten answer, nothing else.",
          prompt: `User question: ${data.question}\n\nDraft answer (facts are correct — polish the wording only):\n\n${factualAnswer}`,
        });
        const polished = (polish.text ?? "").trim();
        return polished.length > 20 ? polished : factualAnswer;
      } catch {
        return factualAnswer;
      }
    }

    async function runWithGeminiFallback(): Promise<{ text?: string }> {
      // Combined mode: run deterministic local search first for correct facts,
      // then let Gemini rewrite for better prose. Guarantees correct data even
      // if Gemini fails; still gets nice writing when Gemini is available.
      const det = await runDeterministic("combined_local_plus_gemini");
      const factual = (det.text ?? "").trim();
      if (!directGeminiKey || !factual) return det;
      toolTrace.push({
        name: "ai_model",
        args: { provider: "gemini_direct_fallback", model: "gemini-2.5-flash", mode: "polish_deterministic" },
        ok: true,
        ms: 0,
        summary: "Local search produced the facts — Gemini rewriting for clarity.",
      });
      const polished = await polishWithGemini(factual);
      return { text: polished };
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
        toolTrace.push({
          name: "ai_model",
          args: { provider: "lovable_gateway", fallback: "selected_source_local_engine" },
          ok: false,
          ms: 0,
          summary: `AI provider failed; using local selected-source engine: ${(error as Error)?.message?.slice(0, 180) ?? "unknown"}`,
        });
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
          result = await runDeterministic(`both_providers_failed:${(fallbackError as Error)?.message ?? "unknown"}`);
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
      // Only sheet:/doc: markers are ledger-verifiable. Legacy `flags[...]`
      // markers are ignored entirely (not counted, not auto-verified) so they
      // cannot bypass the grounding guard.
      if (!/^(sheet:|doc:)/i.test(body)) continue;
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
      // Legacy `flags[...]` markers are no longer auto-verified — they were a
      // hallucination bypass since nothing ties them to the ledger.

    }

    const isFallback =
      /^i don'?t have that in the current dashboard data\b/i.test(rawAnswer);
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
        // Last resort: run the deterministic engine directly against the
        // selected sources so a refusal is never sent when local data exists.
        const { deterministicAnswer } = await import("./copilot-deterministic.server");
        const det = await deterministicAnswer({
          supabase,
          question: data.question,
          regs: regs.map((r) => ({ id: r.id, display_name: r.display_name })),
          docs: docs.map((d) => ({ id: d.id, name: d.name })),
          ledgerSink: ledger as any,
          strictMatch: data.strictMatch === true,
        });
        finalAnswer = det.answer;
      }
    }



    const finalMarkers = new Set<string>();
    const finalInlineRe = /\[([^\]\n]{2,}?)\]/g;
    let finalMarkerMatch: RegExpExecArray | null;
    while ((finalMarkerMatch = finalInlineRe.exec(finalAnswer)) !== null) {
      if (finalAnswer[finalMarkerMatch.index + finalMarkerMatch[0].length] === "(") continue;
      const body = finalMarkerMatch[1].trim();
      if (/^(sheet:|doc:)/i.test(body)) finalMarkers.add(finalMarkerMatch[0]);
    }
    const finalCitationOk =
      /^i don'?t have that in the current dashboard data\b/i.test(finalAnswer.trim()) ||
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

