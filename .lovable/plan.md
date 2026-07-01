## Goal

Rebuild the Insights Overview experience so it reads only from the pasted `/dashboard` (or `/export`) link and renders a Linear/Vercel-grade agentic analytics UI: clean cards, one accent, big confident numbers, a ✦ AI suggestion on every KPI, table row, and panel, and a prominent Next Best Actions core. Every value must trace to the payload — no demo data, no fabricated sections, no "autonomous" wording. Copilot, ingestion, alerts, server functions (other than the existing `fetchInsightUrl`) are untouched. The uploaded screenshots are style reference only; none of their labels, tabs, or numbers appear in the build.

## Scope

- Route: `/insights` → `src/components/InsightDashboard.tsx` (Overview + Sheets rendering only). Copilot tab unchanged.
- Data source: existing pasted link fetched server-side via `fetchInsightUrl` in `src/lib/insights-proxy.functions.ts` (no changes to signature). Refetch on dropdown change becomes `link + ?dimension=…&measure=…`.
- Grounded narrative: existing `generateGemini` (`src/lib/gemini.functions.ts`), one batched call per page.
- No DB writes, no new server functions, no schema changes.

## Recommendation engine (shared, rule-based, instant)

New pure helper `recommendationFor(scope, item, payload) → { id, text, severity: 'high'|'medium'|'low'|'ok', source }`. Uses `column_roles`/`balance_columns`/`consumption_column` when the payload provides them; otherwise falls back to heuristic name matching (balance|stock|qty|closing vs consumption|issued|used).

Rules:
- Inventory row: `balance ≤ 0` → high "Out of stock — reorder now"; `0 < balance < consumption` → medium "Low stock — reorder soon"; `consumption == 0 && balance > 0` → low "No movement — review"; `balance > 4×consumption && consumption > 0` → low "Overstocked — hold ordering"; else ok "Levels healthy".
- Generic (non-stock) row: label matches an `anomalies` entry → high "Outlier — investigate"; blank key field → medium "Missing data — complete"; else ok "Nominal".
- KPI: one line contextual to the metric ("X% of total", "up N vs previous" only if `trends.ready`).
- Section caption: pivot → "{topKey} drives {share}% of {measure}"; anomalies → "{count} outliers, largest {label}"; quality → "Score {score}/100 — fix {topIssue} first"; stock top consumers → "Top {n} consume {share}% of {measure}"; low balance → "{n} items short by cumulative {value}".

Severity colors used everywhere: high = red, medium = amber, low = slate, ok = green. Status pill text: high "Short" / medium "Low" / low "Watch" / ok "OK".

## Data-driven navigation

Sticky top tab bar. Tabs computed from payload, in this order:
- Overview (always)
- Inventory — only if `modules.stock_views.enabled`
- Anomalies — only if `modules.anomalies.count > 0`
- Actions — only if `modules.recommendations?.recommendations?.length`
- Quality — only if `modules.data_quality?.sheets?.length`
- Copilot — unchanged, only if project has copilot access (existing behavior)

Never render Production/Financial/Machine tabs. Anchor scroll (smooth) between sections; each tab jumps to its section on the same page.

## Sections (each self-hides when its data is missing)

1. **Header** — title = `project` (fallback "AI Insights"); ✦ pill = `analysis.mode_badge`; subtitle = `analysis.sheet_analyses[0].summary`. Red alert strip if `analysis.flags.length > 0` ("N issues detected — see Actions"); otherwise a subtle green "No issues detected" chip.

2. **Executive Brief** (hero, ✦) — prominent card, "AI generated" tag, `ai_summary` rendered as readable prose (paragraphs, not code), then 2–4 bullets from `digest.sheets[0].highlights`. If `ai_summary` is missing, use the Gemini batched call output.

3. **Hero KPIs** (≤4) — chosen from `sheet_analyses[0].totals`, preferring labels matching `/grn|issued|consumption|balance|total|value/i`. Each card: big number (thousands separators; ₹ if label matches `/value|amount|cost|price/i`), label, ✦ suggestion line, and a trend arrow ONLY if `trends.ready` (derived from last two `trends.series` points).

4. **Next Best Actions** (the agentic core) — merged, deduplicated, severity-sorted list of:
   - `modules.recommendations.recommendations[]` (as-is)
   - High-severity items from `analysis.flags`
   - Top `modules.anomalies.anomalies[]` → "Investigate {label}: {column} is {value}, {score}× expected"
   - `modules.stock_views.low_balance.data[]` with `value ≤ 0` → "Reorder {key} — short by {|value|}"
   - `modules.data_quality.sheets[0].issues[]` → "Fix data quality: {issue}"
   Each card: left border colored by severity, source badge (Recommendation / Anomaly / Shortage / Quality / Flag), title, muted detail. Buttons "Draft reorder list", "Draft email", "Copy summary" open a dialog with a Gemini-drafted copy-ready text (grounded on the compact facts only). All buttons labeled "Draft"; a small footnote reads "Drafts only — nothing is sent or applied automatically."

5. **Primary chart + Risk feed** (two columns on desktop, stacked on mobile) —
   - Left: horizontal Recharts bar of `modules.pivot.data` titled "{measure} by {dimension}". Two selects populated from `available_dimensions` / `available_measures`; changing either triggers a refetch of the same link with `?dimension=…&measure=…` merged into the URL. Forecast toggle appears only if `forecast.ready`; when on, overlays a line series from `forecast` data if present, otherwise disables.
   - Right: "Risk & Anomalies" feed from top N `modules.anomalies.anomalies[]` in plain English with a severity dot. Empty state hides the panel.

6. **Inventory signals** (only if `modules.stock_views.enabled`) — two ranked bar cards:
   - "Top Consumers" from `top_consumers.data`, caption "by {top_consumers.measure}", top 3 bars each carry a per-bar ✦ note ("X% of total").
   - "Shortages / Low Stock" from `low_balance.data`; negative values rendered in red; each row shows a small "Reorder soon" chip.

7. **Item table** — from `sheets[0].rows` (or the sheet keyed by `sheet_analyses[0].sheet`). Columns: key identifier column + primary measure(s) + Status pill + AI Suggestion (both from `recommendationFor(row)`). Searchable input, sortable by suggestion severity, default collapsed to ~10 with a "Show all" toggle. Helper arrays (`available_*`, `delta_pct`, `enabled`, `numeric_sums`, `column_roles`) are never rendered as rows.

8. **Data Quality** — from `modules.data_quality.sheets[0]`: circular Recharts gauge for `score` (green ≥85 / amber ≥60 / red <60), `issues[]` as labeled chips, plus a "Fix these first" mini list (top 3 issues by severity if provided, else first 3).

9. **Trends** — only if `modules.trends.ready`: multi-line Recharts chart of `series` over `date`, one line per numeric field. Otherwise the entire section is omitted (never render a raw series table).

10. **Inspect raw payload** — collapsed `<details>` at the very bottom.

Any section whose source data is missing or empty is omitted entirely — no empty states, no "coming soon".

## Grounded Gemini (one batched call per page)

Single server call using existing `generateGemini`:
- System: "Answer only from the provided facts. Quote numbers verbatim. Do not compute, estimate, or invent. Keep the given severity. Return strict JSON."
- Payload sent: compact facts only — `{ project, mode_badge, headline_totals, top_actions[], top_anomalies[], quality_summary, precomputed_items:[{id, ruleText, severity, numbers}] }`. Never the full payload, never per-row calls.
- Returns: `{ brief: string, bullets: string[], items: { [id]: { text, severity } } }`. `severity` from Gemini is discarded if it differs from the rule engine's — rules are authoritative.
- Temperature 0.2. On failure, UI falls back to `ai_summary` + rule text unchanged. Draft buttons ("Draft reorder list", "Draft email", "Copy summary") each call Gemini with the same compact facts plus the specific action list; output shown in a dialog with Copy button.

## Formatting & design tokens

- Thousands separators on all numbers (`Intl.NumberFormat`). Currency prefix `₹` when label matches `/value|amount|cost|price|₹/i`.
- One accent color from existing theme tokens (`--primary`). No new colors added. Severity uses existing `destructive` (high), an amber token added to `src/styles.css` if not present (medium), `muted-foreground` (low), and a green token (ok). Reuse existing tokens where available before adding new ones.
- Card grid: `rounded-2xl border bg-card shadow-sm p-5/6`, generous spacing, big display numbers (text-3xl to text-4xl tabular-nums).
- ✦ (Sparkles icon from lucide) on every AI element with a `sr-only` "AI suggestion" label.
- Fully responsive: single column on mobile, 2-col at md, 4-col KPI grid at lg.
- Charts via existing `recharts` + `@/components/ui/chart` wrappers.

## Files touched

- `src/components/InsightDashboard.tsx` — rewrite `OverviewSection` and `SheetsSection`; add `recommendationFor`, `buildFacts`, `pickHeroTotals`, `computeTrendArrow`, `NextBestActions`, `PivotChartCard`, `RiskFeed`, `InventoryTopConsumers`, `InventoryShortages`, `ItemTable`, `QualityGauge`, `TrendsChart`, `DraftDialog`. Remove the generic `FieldVisuals`/`AgenticOverview` spam from Overview.
- `src/components/InsightDashboard.tsx` — data-driven `tabs` array replaces the current fixed tab list; Copilot tab kept intact.
- `src/styles.css` — add missing severity tokens (amber, ok-green) only if not already present.
- No changes to: `src/lib/insights-proxy.functions.ts`, `src/lib/insights-copilot.functions.ts`, `src/lib/gemini.functions.ts`, `src/routes/_authenticated/insights.tsx`, any other server function, ingestion, alerts, notifications.

## Validation

1. Paste the provided `/api/public/.../export?fields=…` link. Confirm:
   - Tabs shown match the fields the payload actually contains.
   - No Production/Financial/Machine tabs appear.
   - Header shows project, mode badge, and summary from the payload.
   - Executive Brief renders `ai_summary` as prose plus digest bullets.
   - Hero KPIs are ≤4, come from `sheet_analyses[0].totals`, and each has a ✦ line.
   - Next Best Actions merges recommendations + flags + top anomalies + low-balance shortages + quality issues, severity-sorted with source badges. Draft buttons open a Gemini dialog labeled "Draft".
   - Pivot chart dropdowns list `available_dimensions/measures` and refetching updates the chart.
   - Inventory panels appear only when `stock_views.enabled`; shortages show negatives in red.
   - Item table columns include a Status pill + AI Suggestion column driven by real row values.
   - Quality gauge color matches score bands; issues render as chips.
   - Trends section is entirely absent when `trends.ready === false`.
   - Raw payload only visible when the `<details>` is expanded.
2. Confirm no hardcoded machines/budgets/products/materials from the reference screenshots exist anywhere in the code (`rg -n "Machine|Compressor|Aluminum|Copper Wire|Plastic Resin|P00[1-5]|F00[1-5]" src/`).
3. Confirm Copilot tab behavior is unchanged (no diff in `src/lib/insights-copilot.functions.ts`).
4. Typecheck passes.
