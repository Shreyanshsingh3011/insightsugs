## Scope

Single file: `src/components/InsightDashboard.tsx`. No other files touched.

## 1. Add `isDelaySheet` helper (top of file, near other helpers)

```ts
function isDelaySheet(sheet: Sheet, analysisIfBasis?: Analysis): boolean {
  const t = (sheet.type || "").toLowerCase();
  if (t.includes("progress") || t.includes("delay")) return true;
  if (analysisIfBasis) {
    const totals = analysisIfBasis.totals || {};
    const delayKeys = ["delayed", "blocked", "at_risk"];
    if (delayKeys.some(k => Number(totals[k]) > 0)) return true;
    const sb = analysisIfBasis.status_breakdown || {};
    if (Object.keys(sb).some(k => k.toLowerCase() !== "unknown")) return true;
    if (analysisIfBasis.mode && analysisIfBasis.mode !== "generic") return true;
  }
  return false;
}
```

Heuristic for "is this sheet the basis of `analysis`": treat the first sheet as the analysis basis (current behavior — `analysis` is workspace-level and effectively describes the primary sheet). Pass `data.analysis` to `isDelaySheet` only for that sheet.

## 2. Refactor `OverviewSection({ data })`

Add internal state and selector:

- Compute `sheets = data.sheets || []`. If empty, render existing analysis-only view (back-compat) or `SectionEmpty`.
- `const [activeLabel, setActiveLabel] = useState(sheets[0]?.label || "")`.
- `useEffect`: if active label not in sheets, reset to first.
- Resolve `selected = sheets.find(s => s.label === activeLabel) || sheets[0]`.
- `const isBasis = selected.label === sheets[0]?.label;`
- `const delay = isDelaySheet(selected, isBasis ? data.analysis : undefined);`

Render at top: the pill-row selector copied from `SheetsSection` (lines 526–537) — same markup, type + row_count badges, same active-state classes.

Then branch:

### Branch A — delay sheet
Render existing Overview JSX unchanged (totals tiles, summary, status_breakdown, flags, risk_score, data_quality, digest, recommendations, extra collapsible). Keep the existing `data.analysis`/`data.modules` source.

### Branch B — generic sheet
- Hero tiles: `selected.kpis` via `HeroKpi` (same grid as SheetsSection lines 539–545).
- Charts grid: `selected.charts` via `MiniBarChart` (same as SheetsSection lines 547–556).
- Then generic module cards from `data.modules` (workspace-level, not per-sheet, but per spec "modules that apply"):
  - `m.data_quality` → Ring card.
  - `m.digest` → Digest card.
  - `m.recommendations` → Recommendations card.
  - Brief views for `m.pivot`, `m.anomalies`, `m.forecast`, `m.trends`, `m.whatif` if present — each rendered as a small `<Card>` with `<GenericValue value={…} />` body and a title from the key.
- Do NOT render: `analysis.totals` tiles, `analysis.summary` callout, `status_breakdown`, `flags`, `risk_score`, `mode_badge`.

Expose the selected label upward via a callback prop `onSelectedChange?: (sheet: Sheet | undefined, isDelay: boolean) => void` so the header badge can react. Call it from a `useEffect` on `[selected?.label, delay]`.

## 3. Tabs gating in `InsightDashboard`

- Compute `hasAnyDelaySheet = sheets.some((s, i) => isDelaySheet(s, i === 0 ? data.analysis : undefined))` via `useMemo` on `[sheets, data.analysis]`.
- Replace static `TABS` usage with `visibleTabs = TABS.filter(t => (t.id === "concerns" || t.id === "reminders") ? hasAnyDelaySheet : true)`.
- Use `visibleTabs` in both the mobile `<Select>` and the desktop rail.
- `useEffect`: if `!visibleTabs.find(t => t.id === tab)` → `setTab("overview")`.
- Guard rendering: `tab === "concerns"` and `tab === "reminders"` blocks only render when `hasAnyDelaySheet`.

## 4. Header badge

Lift Overview's selected sheet into parent state:

- `const [overviewSelected, setOverviewSelected] = useState<{ sheet?: Sheet; isDelay: boolean }>({ isDelay: false });`
- Pass `onSelectedChange={(sheet, isDelay) => setOverviewSelected({ sheet, isDelay })}` to `<OverviewSection>`.
- In header (line ~1272): replace the `modeBadge` chip with:
  - If `overviewSelected.isDelay && modeBadge` → show existing mode badge.
  - Else if `overviewSelected.sheet` → show `<Badge variant="outline">{overviewSelected.sheet.type || overviewSelected.sheet.label}</Badge>`.
  - Else nothing.

## Out of scope

- `SheetsSection`, `ConcernsSection`, `RemindersSection`, `CopilotSection`, `HygieneSection`, server functions, types, other routes — all untouched.
- Delay-sheet Overview rendering is byte-identical to today.
