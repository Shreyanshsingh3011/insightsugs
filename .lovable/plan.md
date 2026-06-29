# Make Copilot fully dynamic (NotebookLM-style) for analytical operations

## Problem

Copilot answers lookup questions ("show row for UG7600022") because it has QUERY-MATCHING ROWS, and summary questions because it has FACTS. But it fails on operational questions like:

- "Top 5 stores by stock value"
- "Bottom 10 items by sales"
- "Total quantity per category"
- "Which vendor has the highest billing?"
- "Average delay by project"
- "List all rows where status = pending, sorted by date"

Two reasons:

1. The system prompt says **"NEVER calculate, estimate, or invent numbers"** — so even when the model could rank, it refuses.
2. The token-based retrieval drops the meaningful words: "top", "5", "by" are filtered as stopwords/short, so QUERY-MATCHING ROWS is empty and the model has nothing concrete to rank.

Aggregates (`buildDashboardFromSheets`) only run for delay/progress sheets and only produce delay metrics — useless for generic sheets.

## Fix: add an Operations Layer executed deterministically on the full dataset

All work stays inside `src/lib/sheets.functions.ts` `askCopilot`. AI stays as planner + phraser; numbers come from JS.

### 1. Operation planner (Gemini, JSON-only, no numbers)

After loading `fullRowsBySheet`, call Gemini once with the question + per-sheet column list + 3 sample rows per sheet and ask it to emit strict JSON:

```text
{
  "operations": [
    {
      "sheet": "<display_name>",
      "op": "top_n" | "bottom_n" | "group_by" | "filter_sort" | "aggregate" | "distribution" | "none",
      "measure": "<column>" | null,
      "agg": "sum" | "avg" | "count" | "min" | "max" | null,
      "dimension": "<column>" | null,
      "filter": [{ "column": "<c>", "op": "eq|contains|gt|lt|gte|lte|between", "value": ... }],
      "sort_by": "<column or measure>",
      "sort_dir": "asc" | "desc",
      "n": <integer>
    }
  ]
}
```

Rules in the planner prompt: use ONLY column names listed; never output numeric results; if the question isn't analytical, return `{"operations": []}`. Reuse the existing retry/fallback `callGemini` helper and the Lovable AI gateway fallback.

### 2. Deterministic executor in JS

Add a small executor that runs each planned operation on `fullRowsBySheet`:

- Number parsing reuses the existing `isNumericLike` cleaner (strip `, ₹ $ € £ % ( )`).
- `top_n` / `bottom_n`: sort rows by measure desc/asc, slice N, return `[{ <dimension>, <measure>, row_index }]`.
- `group_by`: group by dimension, apply agg over measure (or count rows), sort desc, cap to 50 groups.
- `aggregate`: single sum/avg/min/max/count over filtered rows.
- `distribution`: value→count for a categorical column, sorted desc, capped to 50.
- `filter_sort`: apply filter predicates, sort by column, cap to 100 rows.
- All results emitted as a compact JSON block `OPERATION RESULTS` with the sheet name, op spec, and result array. Total block capped (~30 KB) to stay within token budget.

This is the same pattern already used in `insights-copilot.functions.ts` (router + phraser) — we extend it to the main Copilot and execute locally instead of routing to a backend endpoint.

### 3. Always-on cross-cutting heuristics

Even without an analytical question, also precompute and include lightweight per-sheet ranks for any numeric column whose name hints at a measure (value, qty, quantity, amount, total, sum, price, cost, sales, billing, stock, days, delay) — top 10 / bottom 10 by row. This makes one-shot questions like "which store has most stock?" work even when planner JSON parsing fails. Cheap, ~few KB per sheet.

### 4. Update system prompt + user message

- Add `OPERATION RESULTS` block to the user message between `AGGREGATES` and `SHEET ROW SAMPLE`.
- Relax rule 1: numbers may also be quoted verbatim from `OPERATION RESULTS`.
- Add rule: for ranking / top / bottom / sort / "by X" / "per Y" / "highest" / "lowest" questions, the answer MUST be built from `OPERATION RESULTS`; only fall back to QUERY-MATCHING ROWS or FACTS when OPERATION RESULTS is empty.
- Keep all other existing rules.

### 5. Fix token tokenizer for operational keywords

Remove `"how", "many", "what", "which", "show", "list", "give", "me"` from the stopword set when we're trying to find row matches for a ranking question (still skip pure fillers). Also keep numeric tokens up to length 4 so values like "2024", "76", or "UG7600022" survive — drop the `length >= 2 && !STOP` filter for tokens that contain a digit.

### 6. No DB / schema / UI changes

This is a pure server-function change. The `/copilot` page and `sendCopilotMessage`/`askCopilot` signatures are unchanged. RLS unchanged. No new tables, no new secrets — uses existing `GEMINI_API_KEY` / `LOVABLE_API_KEY`.

## Files touched

- `src/lib/sheets.functions.ts` — add planner call, JS executor, OPERATION RESULTS block, prompt tweaks, tokenizer tweak.

## Out of scope

- Insights dashboard Copilot (already has its own router/phraser).
- Document-only questions (RAG path unchanged).
- Persisting operation history.

## Validation

After build, ask in `/copilot` with a generic sheet selected:

1. "Top 5 stores by stock value" → ranked list with verbatim numbers.
2. "Total quantity per category" → group-by table.
3. "Which item has the highest price?" → single row answer.
4. "Show rows where status contains pending sorted by date" → filtered list.
5. Existing lookup ("details for UG7600022") and summary ("summarise this sheet") still work.
