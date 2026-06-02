
# Phase 1 — Google Sheets foundation

Ship a foundation each user can sign into with their own Google account, register the sheets they care about (progress, material reconciliation, procurement, contractor billing, bill tracking, PMS, TAT), have the AI map messy headers into a canonical schema, and view the normalized data inside the app. AI analysis, anomaly flagging, actions/write-back, reminders, and copilot Q&A come in Phase 2+.

## What the user will see

1. **New section: "My Sheets"** under the sidebar.
2. **"Connect Google" button** — opens a popup, user signs in with their own Google account, app gets read access to their Drive/Sheets only. Connection stored per user.
3. **"Add a sheet" flow**:
   - User picks a sheet type from a fixed list: Progress, Material Reconciliation, Procurement, Contractor Billing, Bill Tracking, PMS, TAT.
   - User pastes a Google Sheet URL (or picks from a Drive search later).
   - AI reads the header row + a few sample rows, proposes a mapping from the user's columns → canonical columns for that sheet type.
   - User reviews the proposed mapping, edits if needed, saves.
4. **Sheet detail page** — shows the normalized table (canonical columns), plus a "Refresh from Google" button (manual refresh only — no background polling).
5. **Sheet registry page** — list of all sheets the user has connected, with type, last refreshed timestamp, row count, and unmapped-column warnings.

No write-back, no reminders, no AI summaries, no copilot in this phase.

## Canonical schemas (v1, editable later)

Each sheet type has a small fixed set of canonical columns the AI maps incoming headers into. Starting set:

- **Progress**: activity, owner, dept, planned_start, planned_end, actual_start, actual_end, status, % complete, remarks
- **Material Reconciliation**: material, uom, planned_qty, received_qty, consumed_qty, balance, variance, remarks
- **Procurement**: item, vendor, po_no, po_date, expected_date, received_date, status, remarks
- **Contractor Billing**: contractor, bill_no, bill_date, amount_claimed, amount_certified, amount_paid, status, remarks
- **Bill Tracking**: bill_no, vendor, received_date, due_date, approver, paid_date, status, amount, remarks
- **PMS**: kpi, owner, period, target, actual, variance, status, remarks
- **TAT**: activity, owner, dept, start_date, due_date, completion_date, tat_days, sla_days, breach, remarks

Unmapped source columns are preserved as `extras` (JSON) so nothing is lost.

## Open items deferred to later phases

- **Phase 2**: AI analysis per sheet, anomaly/slippage detection, in-app dashboards per sheet type.
- **Phase 3**: Actions inside the app → write-back to a dedicated "Lovable Actions" tab in each sheet; cross-department tagging.
- **Phase 4**: Reminders fan-out (in-app + Email via Lovable Emails + WhatsApp/SMS via Twilio).
- **Phase 5**: Copilot Q&A grounded on all connected sheets + AI suggestions for cleaning up the source sheet descriptions.

I'll surface each phase as its own plan when you're ready.

## Technical details

- **Per-user OAuth**: requires your own Google Cloud OAuth client (Lovable's Google Sheets connector is workspace-scoped — it would give every user access to *your* sheets, which is not what you want). You'll need to create an OAuth client in Google Cloud Console with the `https://www.googleapis.com/auth/spreadsheets.readonly` and `https://www.googleapis.com/auth/drive.metadata.readonly` scopes; I'll use the App User Connector pattern (`authorizeAppUserOAuth` + `callAsAppUser`) so each end-user authorizes their own Google account through a popup. I'll request the Client ID secret from you when we get there.
- **New tables** (Lovable Cloud / Supabase, all RLS-scoped to the owning user):
  - `google_connections` — stores per-user `connection_id` from the App User Connector.
  - `sheet_registry` — user_id, sheet_type, google_sheet_id, tab_name, display_name, last_refreshed_at.
  - `sheet_column_mappings` — sheet_registry_id, source_header, canonical_field, JSON of unmapped-extras config.
  - `sheet_rows` — sheet_registry_id, row_index, canonical JSON, extras JSON. Refreshed on manual refresh (full replace).
- **AI mapping** runs server-side via `createServerFn` calling Lovable AI Gateway (`google/gemini-3-flash-preview`) with the header row + 5 sample rows + canonical schema → returns mapping JSON the user then approves.
- **Sheet read** uses `callAsAppUser` against `https://connector-gateway.lovable.dev/google_sheets/v4/spreadsheets/{id}/values/{range}`.
- No changes to existing dashboard/auth/admin routes.

## Risks / things to confirm at build time

- Google OAuth Client ID setup is a one-time manual step on your side in Google Cloud Console — I'll give exact instructions when we start building.
- Sheets with >1000 rows are fine but the first read may be slow; manual refresh per your choice avoids quota issues.
- "Parity in description" recommendations (rewriting source sheets) is Phase 5 — for now the canonical mapping handles inconsistency virtually.

Approve to start Phase 1, or tell me what to adjust.
