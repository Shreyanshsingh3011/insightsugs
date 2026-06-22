# Co-pilot accuracy overhaul

Today the Co-pilot fails on many valid questions because (a) the quantitative parser only matches a narrow set of phrasings, (b) the qualitative retriever sends a tiny keyword-filtered slice of rows so the LLM literally doesn't see the answer, and (c) the system prompt rejects anything it can't tag. Fix all three so every question is answered from the data, and numbers stay exact.

## What changes for the user

- Any question about the selected sources gets a real answer, not "That isn't in the selected sources."
- Numeric answers (counts, totals, averages, min/max, group-bys, "which X has the most Y") remain exact — still computed in JS, never by the LLM.
- Narrative answers cite specific rows / concerns / reminders that actually exist.
- If a question genuinely has no answer in the data, Co-pilot says so and suggests what to enable.

## How it works

### 1. Always give the LLM the full picture (within budget)

Rewrite `src/lib/notebook/retrieve.ts` to build a structured context, not a keyword-filtered list:

- **Schema block** per enabled sheet: label, row count, every column name, and the inferred type (number / date / text / categorical) based on a scan of the column's values.
- **Precomputed facts block** per sheet (computed in JS, sent as ground truth the LLM must quote verbatim):
  - total rows (excluding Total / Sub Total rows)
  - for every numeric column: sum, avg, min, max, count of non-empty values
  - for every low-cardinality text column (≤25 distinct values): value → count map
- **Rows block**: the actual data as a compact pipe-delimited table with a row-index column, capped by character budget (~60 KB total). If a sheet is larger than the budget, keep the top-scored rows for the question plus a uniform sample so totals/distributions stay representative, and note "showing N of M rows".
- **Concerns / Reminders blocks**: full list when enabled (they're small).
- Each row / concern / reminder still carries its `[[Sheet:label|row:N]]` / `[[Concern:id]]` tag for citation.

### 2. Broaden and harden the quantitative parser

In `src/lib/notebook/router.ts` and `compute.ts`:

- Accept more phrasings: "tell me the total ...", "what's the average ...", "list ... by ...", "break down ... by ...", "distribution of ...", "share of ...", "show ... per ...", "rank ... by ...", bare "count of ...".
- Add `distribution` / `topN` / `bottomN` / `share` aggregations on top of existing sum/avg/min/max/count/groupCount/groupSum/argmax/argmin.
- Column / sheet matching: tolerate plurals, spaces, hyphens, and partial matches; pick the best column across all enabled sheets when the question doesn't name a sheet.
- Filter parsing: support multiple `where X = Y and Z in (a, b)`, plus implicit filters like "open concerns" → `status=open` on the Concerns source.
- When parsing succeeds, evaluate in JS, then send Gemini the computed result plus a 1-line phrasing instruction (existing path, unchanged guarantee that the LLM cannot alter the number).
- When parsing fails but the question is clearly numeric, fall through to qualitative with the precomputed-facts block — the LLM will read the exact figure from the facts table instead of doing math.

### 3. Relax the qualitative prompt so it actually answers

Edge function `supabase/functions/copilot-notebook/index.ts`:

- New system prompt: "Answer using only the provided context. Quote any number directly from the Precomputed Facts block — never compute one yourself. For each specific claim append the matching `[[…]]` tag. Use markdown for lists / tables. If the answer truly isn't in the context, say so and suggest which source to enable."
- Drop the blanket "if asked for a count, refuse" rule — the facts block already has the counts.
- Raise `maxOutputTokens` to 4096 so longer summaries / breakdowns aren't truncated.
- Offline fallback (no `GEMINI_API_KEY`): render the precomputed facts + top matching rows as a markdown answer instead of three bullet points; quantitative path keeps working unchanged.

### 4. Verify citations against live data

`src/lib/notebook/verify.ts`: keep current behavior (drop citations whose row/concern/reminder doesn't exist) and additionally surface a small "unverifiable claim" note if the LLM returned zero valid citations for a non-empty answer — so users see when to double-check.

### 5. UI polish in `NotebookCopilot.tsx`

- Render assistant messages with `react-markdown` (tables, lists, bold) — currently they're plain `whitespace-pre-wrap`.
- Replace the "No sources selected" copy path with an inline CTA that re-enables all sources in one click.
- Keep the Computed / AI badge; add a tiny "facts used" disclosure under numeric answers showing which precomputed fact was quoted.

## Technical notes

- All math stays in `compute.ts` (JS). The LLM only phrases numbers it is handed.
- Context budget enforced by character count before send; rows are sampled deterministically (top-scored first, then every Nth) so re-asking the same question is stable.
- Type inference for columns is a one-pass scan over up to 200 sampled values; cached per `(token, sheet)` in component memo.
- No schema changes. No new tables. No new secrets.
- Files touched: `src/lib/notebook/retrieve.ts`, `src/lib/notebook/router.ts`, `src/lib/notebook/compute.ts`, `src/lib/notebook/verify.ts`, `src/components/notebook/NotebookCopilot.tsx`, `supabase/functions/copilot-notebook/index.ts`. `react-markdown` is already a project dependency.

## Acceptance

Using the seeded DelayBridge link:

1. "summary" / "overview" → markdown summary of every enabled source with row counts and key columns.
2. "how many concerns are open" → exact count, Computed badge.
3. "total <numeric column> in <sheet>" and "average …", "max …", "min …" → exact, Computed badge.
4. "which <column> has the most line items" / "break down by <column>" / "distribution of <column>" → exact group-by table, Computed badge.
5. "what's blocking cabling" with Concerns enabled → narrative cites the seeded concern; with Concerns disabled → narrative cites sheet rows only.
6. Question with no answer in the data → "That isn't in the selected sources" plus a suggestion of which source to enable.
7. `GEMINI_API_KEY` unset → numeric questions still exact; narrative questions return a markdown extract of facts + top rows instead of failing.