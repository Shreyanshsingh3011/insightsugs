## Goal

Turn the Insights **Overview** tab into a fully dynamic, agentic dashboard that renders whatever the pasted link returns from `/api/public/<token>/export?fields=...` — including `summary, totals, status_breakdown, sheets, variance, flags, data_dashboard, copilot, data_quality, pivot, forecast, anomalies, digest, recommendations, trends, whatif, stock_views` — without hardcoding for delay-specific shapes.

Copilot code path is untouched (as requested). Only the Overview render + link handling change.

## Scope

- File: `src/components/InsightDashboard.tsx` (only overview + link input; Copilot subtree left alone).
- No backend / server-fn changes. Everything is fetched client-side from the user's link, exactly like today.
- No new dependencies (reuse recharts, shadcn cards, existing helpers).

## 1. Accept the full link as-is

Update `normalizeBase` so pasting the exact URL
`https://.../api/public/<token>/export?fields=summary,totals,...`
is accepted and preserved:

- Keep stripping trailing `/dashboard|/copilot|/concerns|...`, but for `/export` keep the path AND the `?fields=...` querystring intact.
- Store two things in link state: `base` (root used for `/copilot`, `/concerns`, `/reminders`, `/harmonize`) and `exportUrl` (the exact URL the user pasted when it points at `/export`, otherwise `${base}/export?fields=<all-known-fields>`).
- The Overview fetch uses `exportUrl`; existing sub-fetches (copilot etc.) keep using `base`.

Result: user pastes the long export link → it's accepted, remembered in localStorage + `?link=` param, and drives Overview.

## 2. Field-driven Overview renderer

Replace the current fixed Overview layout with a registry that maps each known field key to a renderer block. The Overview renders **only** the blocks whose field is present (non-empty) in the response, in this order:

```text
summary            → hero card (markdown-ish text + mode_badge + risk_score ring)
totals             → KPI strip (auto from key/value pairs)
status_breakdown   → donut + legend
data_quality       → score ring + issues list
digest             → "Today's briefing" card
recommendations    → action list with severity chips
flags              → prioritized alert feed (severity color, click → detail)
anomalies          → anomaly cards (metric, expected vs actual, delta%)
variance           → variance table + bar chart of top |delta|
trends             → multi-series line/area chart per metric
forecast           → line chart w/ forecast band (actual + predicted + CI)
pivot              → interactive pivot (dims/measures from payload; reuses existing pivot logic)
whatif             → sliders bound to declared inputs → derived outputs
stock_views        → per-view cards (table / kpis / chart auto-detected)
data_dashboard     → generic auto-viz: KPIs at top, then chart-per-numeric-series, then table
sheets             → existing per-sheet Bento (kept)
```

Each renderer is defensive: it accepts either the documented shape OR a plain object/array and falls back to `GenericValue` / `ObjectArrayTable` / `KVList` so unknown sub-shapes still render usefully. No block throws when a field is missing or malformed.

## 3. Agentic layer (client-side, on top of the fetched payload)

Purely presentational — no new server calls, no writes. Uses the existing `generateGemini` helper only if `hasGemini` is true, otherwise falls back to rule-based summaries so the page still feels "agentic" with zero AI.

Added to the Overview header:

1. **Agent Brief** card — one-paragraph situational summary synthesized from `summary + totals + risk_score + top flags + digest`. Uses Gemini when available; otherwise a deterministic template.
2. **Next Best Actions** — ranks `recommendations + flags(high) + anomalies` into 3–5 actionable cards with a "Why" popover citing the field it came from.
3. **Auto-KPI extraction** — if `totals` is missing, derives KPIs from any numeric leaves in `data_dashboard` / `stock_views`.
4. **Signal chips row** — shows which fields the link returned (`enabled_fields` ∪ detected non-empty keys), so the user can see the agent is using the full payload.
5. **Ask the data** quick chips (Anomalies? Top variance? Forecast next period?) — each pre-fills the existing Copilot input (Copilot itself unchanged).

Everything degrades gracefully: no field present → block hidden; AI unavailable → deterministic version.

## 4. Refresh + transparency

- Header shows: active link (truncated + copy), last-fetched timestamp, and a "Refresh" button that re-hits `exportUrl`.
- "View raw payload" collapsible at the bottom of Overview (uses existing `GenericValue`) so anything the registry didn't recognize is still inspectable.
- If a field is listed in `enabled_fields` but returns empty, show a subtle "no data" chip instead of hiding it silently.

## 5. Untouched

- Copilot component and its data flow (`/copilot` endpoint, question chips, streaming, follow-ups) — no edits.
- Sheets tab, Concerns tab, Reminders tab, Harmonize tab — no edits.
- All server functions, RLS, auth, routes.

## Technical notes

- Single new state: `exportUrl` derived from `useLinkInput`.
- Single React Query key change: `["insights-overview", exportUrl]`.
- Field registry is a `Record<string, { title: string; render: (value: unknown, ctx) => ReactNode }>` inside `InsightDashboard.tsx`; keeps the file self-contained.
- No new files needed; if the file grows too much, split renderers into `src/components/insights/overview-blocks.tsx` in the same edit.

## Deliverable

After approval, one edit pass on `src/components/InsightDashboard.tsx` implementing steps 1–4. Verified by pasting the example link and checking every listed field renders a matching block, missing fields are hidden, and Copilot still works exactly as before.
