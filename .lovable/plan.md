## Problem

The "store summary" sheet (2696 rows) is imported with **garbage headers**, so Copilot can't find any store/item even though the user is querying real data.

Inspecting `sheet_rows` for that sheet shows the columns are numeric totals like `208,13,53,972`, `4,42,76,563`, `83,17,18,139` — i.e. a **totals row was used as the header row**, and the cells underneath are header labels (`GRN Value`, `Loan MRN Value`, `Balance at Store`, etc.) treated as data.

## Root cause

In `fetchAppsScript` (src/lib/sheets.functions.ts ~line 161), `looksLikeHeader` only checks that a row has ≥2 non-blank cells. The totals row passes that check, so it's promoted to headers and the actual header row below is treated as a data row. The Item Code column (`UG7600022`) and Store Name column (`NIT-76 Patna (WEST)`) end up nested inside `extras` under nonsense keys, so neither the Copilot context nor exact-value scans can find them.

The Documents tab works because the PDF parser is unrelated.

## Fix

Tighten header detection in `src/lib/sheets.functions.ts → fetchAppsScript`:

1. Replace `looksLikeHeader` so a row only qualifies as a header if it has ≥2 non-blank cells **and** the majority of non-blank cells are non-numeric text (reject rows where most cells parse as numbers — those are totals/subtotal rows).
2. Always scan the first ~20 rows for the best header candidate, even when the parser's initial `headers` array is non-empty but looks numeric. Today the check is gated on `!looksLikeHeader(table.headers)`; switch to: if current headers fail the stricter test, search rows for the first qualifying row and promote it.
3. Keep the existing blank/duplicate column cleanup unchanged.

## After the code fix

Existing rows in the DB are still corrupt. The user must **re-sync the "store summary" sheet** (Sheets → open sheet → Refresh) so it re-imports with the correct headers. I'll call this out in the closing message and leave a note in the sheet detail UI only if needed (no UI change planned unless the user asks).

## Files touched

- `src/lib/sheets.functions.ts` — header detection inside `fetchAppsScript` only. No changes to Copilot, RAG, RLS, or schemas.
