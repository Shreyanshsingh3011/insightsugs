## Problem

On `/copilot`, asking "summary of this sheet" for a generic sheet ("Store summary", 2697 rows) returns a delay-specific template (Delayed / Blocked / Completed / At Risk / Risk Score — all 0). That's because `askCopilot` always calls `buildDashboardFromSheets`, which is hard-wired to delay/progress semantics, and feeds those zeros into the prompt as `AGGREGATES`. The LLM then mirrors that template even when the sheet has nothing to do with delays.

The rest of the grounding (full-row FACTS via `inferColumnStats`, query-relevant token counts, relevance-scored ROW SAMPLE, document RAG chunks) is already generic and per-sheet — that part stays.

## Fix (small, surgical, frontend/server-fn only)

1. **Skip the delay aggregates for non-delay sheets** in `src/lib/sheets.functions.ts → askCopilot`:
   - Only call `buildDashboardFromSheets` when at least one selected sheet has a delay-style `sheet_type` (`progress`, `pms`, `vendor_billing`, `delay` — match the types the dashboard was designed for; `generic` and everything else is excluded).
   - When skipped, omit the `AGGREGATES:` block from the user message entirely so the model doesn't see a zeroed Delayed/Blocked/Completed/At Risk/Risk Score table.

2. **Make the system prompt sheet-agnostic** in the same function:
   - Replace the implicit delay framing with: "Adapt the answer shape to the actual columns in FACTS for each sheet. Do NOT invent fields like Delayed/Blocked/At Risk/Risk Score unless those columns appear in FACTS."
   - Keep all existing numeric-grounding rules (numbers must come verbatim from FACTS / QUERY-RELEVANT FACTS / AGGREGATES).
   - For "summary" style questions, instruct: report row count, list the actual columns, and surface the top categorical values and key numeric stats that `inferColumnStats` already produced.

3. **No schema, RLS, or UI changes.** No new tables, no new server fns, no Emergent calls. Lovable AI + Gemini paths in `askCopilot` are untouched.

## Files touched

- `src/lib/sheets.functions.ts` — `askCopilot` only:
  - gate `buildDashboardFromSheets` on delay-style `sheet_type`s
  - drop `AGGREGATES` block from prompt when not computed
  - rewrite the `system` prompt to be sheet-type-agnostic and explicitly forbid the delay template for generic sheets

## Verification

- Typecheck with `tsgo`.
- Manually re-ask "get me the summary of this sheet" against the Store summary (generic) sheet — answer should describe actual columns (row count, top categories, numeric stats) with no Delayed/Blocked/At Risk wording.
- Re-ask a question on a real Progress/PMS sheet — delay aggregates should still appear.
