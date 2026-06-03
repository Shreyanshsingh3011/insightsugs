## Plan — Apps Script-driven sheets + multi-sheet AI

### Goal
Replace per-user Google OAuth with a registry of public Apps Script web app URLs (one per sheet). Keep AI copilot working as today, plus let the user pick multiple registered sheets as context for a single question.

### Scope changes vs current code

**Remove (Google OAuth path):**
- `src/integrations/lovable/appUserConnector.ts`, `appUserConnectorClient.ts`
- "Connect Google" UI + start-OAuth server fn
- `google_connections` table
- The "inspect sheet via Google Sheets API" path

**Keep / repurpose:**
- `sheet_registry` table — repurposed to store Apps Script URL instead of spreadsheet ID
- `sheet_column_mappings`, `sheet_rows` tables — unchanged
- `sheet-schemas.ts` canonical schemas — unchanged
- `/sheets` and `/sheets/$sheetId` routes — kept, simplified

### Phase 1a — Apps Script registry & ingest

1. **DB migration**
   - `sheet_registry`: drop `google_connection_id`, `spreadsheet_id`, `sheet_name` columns; add `apps_script_url text not null`, keep `title`, `sheet_type`, `user_id`, timestamps.
   - Drop `google_connections` table.

2. **Server functions** (`src/lib/sheets.functions.ts`, rewritten)
   - `registerSheet({ title, sheetType, appsScriptUrl })` — validates URL (`https://script.google.com/.../exec`), fetches once to confirm it returns JSON, runs AI column-mapping against the headers, returns suggested mapping for user approval.
   - `saveSheetMapping({ sheetId, mapping })` — stores in `sheet_column_mappings`.
   - `syncSheet({ sheetId })` — fetches Apps Script URL, normalizes rows using mapping, upserts into `sheet_rows`. Manual trigger only (per earlier decision).
   - `listSheets()` / `getSheetRows({ sheetId })` — unchanged behavior.
   - `deleteSheet({ sheetId })`.

3. **UI** (`/sheets`)
   - "Add sheet" dialog: title, sheet type dropdown (7 canonical types), Apps Script URL field.
   - On submit → call register → show AI-suggested mapping → user confirms → save + sync.
   - List of registered sheets with Refresh + Delete buttons.

### Phase 1b — AI Copilot with multi-sheet context

1. **New route** `/copilot` (already partially scaffolded? if not, add it).
2. **UI**: chat-style input + a multi-select list of the user's registered sheets ("Use sheets as context").
3. **Server fn** `askCopilot({ question, sheetIds[] })`:
   - Loads rows for each selected sheet (capped, e.g. 500 rows/sheet to stay within token budget).
   - Builds a structured context block: `[sheet title, type, mapped columns, rows…]` per sheet.
   - Calls Lovable AI Gateway (`google/gemini-3-flash-preview`) with system prompt explaining the canonical schemas + "answer based only on provided sheet data, cite sheet titles".
   - Returns `{ answer, sourcesUsed }`.
4. Render answer + which sheets contributed.

### Apps Script response contract (expected)
The deployed `doGet(e)` should return JSON like:
```json
{ "headers": ["activity","owner",...], "rows": [["Foundation","R. Kumar",...], ...] }
```
If a user's script returns a different shape (e.g. array of objects), the register step's AI mapping will detect and normalize. We'll document the recommended shape in the Add-Sheet dialog.

### Out of scope (later phases, unchanged)
- Anomaly detection / proactive status indicators
- Write-back to an "Actions" tab
- Reminders (email / WhatsApp / SMS)
- Source-sheet description parity recommendations

### Technical notes
- Apps Script URLs are public → simple `fetch()` from a server function. No connector, no OAuth.
- All tables remain RLS-scoped to `user_id = auth.uid()`.
- `LOVABLE_API_KEY` already provisioned for AI calls.
- No new secrets required.

### Risks
- A public Apps Script URL leaks the sheet data to anyone who has the URL. Acceptable per user's "Public — Anyone" choice, but we'll show a one-line warning in the UI.
- Large sheets (>1000 rows) sent to AI will be truncated; we'll surface this in the copilot response.
