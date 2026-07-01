## Plan

I’ll make the Insights experience feel like a real agentic AI dashboard, not a raw JSON viewer.

### 1. Fix the real data path first
- The current `/export?...` request is failing in the browser with `Failed to fetch`, so the new agentic overview has no payload to render.
- Add a server-side proxy fetch for the pasted export/dashboard links using `createServerFn + requireSupabaseAuth`, so external calls happen server-side and CORS/network failures do not break the dashboard.
- Keep the pasted link as the only data source; no database writes and no Copilot changes.

### 2. Make Overview genuinely agentic
- Replace the current “raw module cards” behavior with a dashboard intelligence layer that converts any returned payload into:
  - Executive brief
  - Key metrics
  - Health/risk score
  - Priority actions
  - Alerts/anomalies
  - Forecast/trend/variance visual sections
  - Data quality summary
  - Auto-discovered charts from the full `sheets`, `data_dashboard`, and `stock_views` payload
- Render all known fields (`summary`, `totals`, `status_breakdown`, `variance`, `flags`, `data_dashboard`, `data_quality`, `pivot`, `forecast`, `anomalies`, `digest`, `recommendations`, `trends`, `whatif`, `stock_views`) as visual cards/charts/tables instead of dumping objects.
- Only keep raw JSON hidden under a small “Inspect raw payload” developer-style disclosure at the bottom.

### 3. Upgrade the Sheets tab into an analytic workspace
- Add a sheet-level agent header with:
  - Auto-generated sheet summary
  - Data quality indicators
  - Key dimensions and measures
  - Suggested questions/actions
- Auto-create charts for every useful categorical + numeric combination, including item/store/material style data.
- Add pivot-like summaries and top/bottom rankings directly above the table.
- Keep the current searchable/filterable/downloadable table, but make it a detail view instead of the main experience.

### 4. Make the dashboard dynamic for any future link
- Add defensive shape detection so arrays, nested objects, dashboards, pivots, forecasts, stock views, and unknown module shapes still become useful visual blocks.
- Avoid delay-specific assumptions unless the payload clearly contains delay/risk fields.
- Use generic naming: “signals”, “records”, “entities”, “measures”, “segments”, “actions”.

### 5. Preserve what should not change
- Do not change Copilot logic.
- Do not change ingestion, alerts, notifications, documents, RLS, or existing workflows.
- Keep existing UI patterns and route structure.

### Technical changes
- Add a small server function in `src/lib/insights-proxy.functions.ts` for authenticated server-side fetching of the user-provided public analytics URL.
- Update `src/components/InsightDashboard.tsx` to use that proxy for dashboard/export fetches.
- Expand `InsightDashboard.tsx` with reusable helpers for:
  - payload normalization
  - numeric measure detection
  - categorical dimension detection
  - top-N rankings
  - chart/table block selection
  - agentic summary/action extraction
- Replace raw `GenericValue` module rendering in Overview and Sheets with visual blocks and keep raw output collapsed only for inspection.

### Validation
- Paste the provided long `/export?fields=...` link.
- Confirm Overview renders agentic sections instead of raw JSON.
- Confirm Sheets tab shows summaries, charts, rankings, filters, and table.
- Confirm Copilot tab still uses the existing flow unchanged.