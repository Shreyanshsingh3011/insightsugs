# Generic Gemini-routed Copilot for Insights

Scope: only `CopilotSection` in `src/components/InsightDashboard.tsx` + one new server function. No other section, no delay-sheet behavior change.

## New server function

Create `src/lib/insights-copilot.functions.ts` with two `createServerFn` endpoints (both `requireSupabaseAuth`, both call Lovable AI Gateway with `google/gemini-3-flash-preview`, low max tokens):

1. `routeInsightQuestion({ question, sheets })`
   - Input: question string + per-sheet `{ label, type, row_count, columns:[{name,type}], available_dimensions, available_measures }`.
   - System prompt: "You are a router. Choose ONE endpoint and params from the catalog. Use ONLY column names from the provided list. Return JSON ONLY, no prose, no numbers."
   - Endpoint catalog passed in prompt: `dashboard`, `pivot{dimension,measure,agg:sum|avg|count,sheet}`, `anomalies{sheet}`, `quality{sheet}`, `whatif{sheet}`, `forecast{sheet}`, `trends{sheet}`, plus `none`.
   - Uses AI SDK `Output.object` with a tiny Zod schema `{ endpoint, params?, sheet?, reason? }`. Returns parsed object.

2. `phraseInsightAnswer({ question, endpoint, params, payload })`
   - System prompt: "Write a brief answer to the user's question using ONLY the numbers in `payload`. Quote numbers verbatim — never round, recompute, sum, average, or invent values. If payload lacks the answer, say so."
   - Payload is trimmed JSON (cap size, e.g. top 50 rows of a pivot table).
   - Returns `{ text }`.

Both read `process.env.LOVABLE_API_KEY`. No data math server-side; pure routing + phrasing.

## Frontend rewrite of `CopilotSection`

Replace the current `${base}/copilot` mutation with this flow:

1. Build runtime catalog from the dashboard data already in scope:
   - Pass `sheets` (already has `label`, `type`, `row_count`, `columns`) plus `available_dimensions` / `available_measures` from `data.modules.pivot` keyed per-sheet when present. Lift `data` into props (extend `CopilotSection` props to accept the loaded `DashboardData`).
2. On send:
   a. Short-circuit: if question matches a trivial total/avg/count of a single measure (regex on "total/average/count of X"), call `${base}/pivot` directly (or use `data.kpis`), skip Gemini routing.
   b. Otherwise call `routeInsightQuestion` → get `{endpoint, params, sheet}`.
   c. Validate chosen columns exist on that sheet's column list. If invalid → show honest "No matching column on <sheet>" message. Optional fallback: `${base}/copilot`.
   d. Call the chosen `${base}/<endpoint>` with params (GET with query string for pivot/anomalies/etc.; existing `apiGet`/`apiSend` helpers).
   e. If endpoint returns `{message: "..."}` / not-ready / 404, relay verbatim, do not fabricate.
   f. Call `phraseInsightAnswer` with question + raw payload (trimmed). Render returned text. Show small chip with endpoint + sheet used.
3. Session cache: `Map<string, {text, endpoint}>` keyed by `${active}|${sheet}|${normalizedQuestion}`. Reuse on repeat.
4. Remove hardcoded chips that assume delay/concerns vocab; replace with generic chips derived from columns: "Top {firstDimension} by {firstMeasure}", "Summarize this sheet", "Anomalies", "Data quality". Generated at render time from runtime catalog.

## Guardrails

- Gemini never sees raw rows for routing — only column metadata.
- Phrasing call receives numbers only via `payload`; system prompt forbids transformation.
- `max_tokens` ~256 routing, ~400 phrasing.
- All keys server-side via `createServerFn`; browser never sees `LOVABLE_API_KEY`.
- No changes to other sections, OverviewSection, delay rendering, or other tabs.

## Files touched

- `src/lib/insights-copilot.functions.ts` (new)
- `src/components/InsightDashboard.tsx` — rewrite `CopilotSection` body, pass `data` into it from the parent render call at the existing tab switch.

## Out of scope

Anything outside `CopilotSection`. Delay-sheet UI, Overview, Concerns, Reminders, Hygiene, Sheets tabs untouched.
