
## Problem

Two issues are visible on the My Sheets → Add API endpoint flow:

1. The "Review column mapping" step shows blank source headers and defaults every row to `material`, so saving stores garbage and nothing maps. This is because the heuristic fallback in `proposeMapping` treats empty/whitespace headers as matching the first canonical field (`"".includes(...)` is always true), and the generic API the user is pasting doesn't fit any of the seven hard-coded "canonical" schemas anyway.
2. The in-app Co-pilot (`/copilot`) only reads document RAG; it never queries the rows ingested from these sheets, so it can't answer "what is value 27", sums, counts, or lookups against the sheet data.

## What I'll change

### 1. One-click sheet import (no manual mapping)

- Add a `"generic"` entry to `SHEET_TYPES` / `SHEET_TYPE_LABELS` / `CANONICAL_FIELDS` (empty canonical list). Make it the default in `AddSheetDialog`.
- For `generic` (and whenever the user accepts the AI suggestion), skip the "Review column mapping" step entirely:
  - After `inspectSheet` succeeds, auto-call `registerAndSyncSheet` with the proposed mapping (all columns become `extras` for generic) and close the dialog.
  - Keep an "Advanced: review mapping" toggle for power users on the seven typed schemas.
- Fix `proposeMapping` heuristic: skip empty/whitespace headers, require non-empty normalized header before substring matching, never collapse to "first canonical".
- Tighten `fetchAppsScript` to drop fully-empty header columns and trim header strings, so the table shown later isn't full of blank columns.

### 2. Make Co-pilot answer accurately from imported sheets

Extend `sendCopilotMessage` in `src/lib/copilot.functions.ts` so it can ground answers on `sheet_rows` in addition to document chunks:

- Before the RAG call, pull a compact catalog of the user's sheets from `sheet_registry` + first ~50 rows per sheet (headers, value types, distinct counts for low-cardinality columns).
- Detect quantitative/lookup intent (sum/avg/count/min/max/"what is", row lookup by value) with a small router prompt that returns `{ kind, sheet, column, op, filterValue }` — same shape already used in `insights-copilot`.
- For quantitative intents, fetch all matching rows from `sheet_rows` via `supabaseAdmin` (already used elsewhere for cross-sheet reads), compute the answer in JS (facts-first), and pass the verified numbers to Gemini only for phrasing.
- For lookup intents ("what is 27", "show row where X=Y"), scan rows server-side and return the exact matching row(s) as Markdown table — no model math.
- Fall back to existing document RAG when the question isn't sheet-shaped.
- Add `sheet:<display_name>` / `field:<header>` citations alongside the existing document citations.

### 3. UI tidy

- `AddSheetDialog`: default sheet type → "Generic table", URL field always visible, success toast jumps straight to the sheet detail page.
- Sheets list: show a small "auto-mapped" badge when all columns landed in `extras`, with a "Map columns" link that opens the existing mapping editor (for users who later want canonical mapping).

## Files touched

- `src/lib/sheets-schemas.ts` — add `generic` type.
- `src/lib/sheets.functions.ts` — heuristic fix, header trim, generic handling.
- `src/routes/_authenticated/sheets.tsx` — auto-register flow, advanced toggle, default type.
- `src/lib/copilot.functions.ts` — sheet catalog, intent router, JS-computed facts, citations.
- `src/routes/_authenticated/copilot.tsx` — render new `sheet:`/`field:` citation chips (small change).

No DB migrations, no new secrets, no changes to existing alerts/notifications/RAG ingestion.
