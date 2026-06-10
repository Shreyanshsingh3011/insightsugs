## Scope

Four discrete changes across Sheets, Dashboard, Projects, plus a user-matching helper.

---

## 1. Sheets page — per-row actions

File: `src/routes/_authenticated/sheets.tsx`

- Each row in the sheet registry list gets two new icon buttons:
  - **Open sheet link** — opens `apps_script_url`'s associated Google Sheet in a new tab. If `sheet_registry` does not already store the raw spreadsheet URL, add a small dialog that lets the user paste/edit it (column `source_url`, see migration below).
  - **Add API endpoint** — opens the existing "register sheet" dialog pre-populated for editing the Apps Script URL of that row (re-uses the existing `registerSheet`/`updateSheetEndpoint` server fn).
- Add a new top-level "Add API endpoint" button that opens the same dialog in create mode (parity with existing flow; just makes it visible).

Migration: `ALTER TABLE public.sheet_registry ADD COLUMN source_url text;` (nullable, no policy change).

---

## 2. Dashboard — Dependent Activity table on home

File: `src/routes/_authenticated/dashboard.tsx` + new component `src/components/DependentActivitiesTable.tsx`.

Behaviour:
- New card "My dependent activities" near the top of the dashboard, visible to all signed-in users.
- Data source: existing dependency mapping in `dep-store.ts` / `dependencies.functions.ts` joined with the user's matched activities (see §4).
- Each row shows: activity name · predecessor activity · predecessor status · my status.
- Rows whose predecessor is **not cleared** render at 50 % opacity and are non-interactive (cursor-not-allowed). Cleared predecessors → full opacity and clickable.
- Clicking a clickable row opens a dialog ("Dependency details") listing the full predecessor → successor chain (re-use `dependency-chain.ts`) with statuses, sheet origin, and a deep-link to `/sheets/$sheetId`.

---

## 3. Dashboard — gate dependency mapping section to super admin

Same file. Wrap the existing dependency-mapping/settings section with a `useSession()`-derived `isSuperAdmin` check. Non-super-admins simply don't see it. No data change.

---

## 4. User ↔ activity matching helper

New file: `src/lib/user-activity-match.ts` (pure helper) + a server fn `getMyActivities` in `src/lib/sheets.functions.ts`.

Logic:
1. For each registered sheet's rows, look in `canonical`/`extras` for an email-like field (`email`, `assignee_email`, `owner_email`). If it matches `auth.user.email` (case-insensitive), include the row.
2. Else, fall back to comparing a name-like field (`assignee`, `owner`, `name`, `responsible`) against `profile.full_name` (case-insensitive, trimmed).
3. Return `{ sheet_id, row_index, activity_name, status, matched_via: 'email' | 'name' }`.

This feeds the new dashboard table in §2 and is also reusable for `my-activities.tsx`.

---

## 5. Projects page — pickup from a registered sheet

File: `src/routes/_authenticated/projects.tsx` + new server fn `listProjectsFromSheets` in `src/lib/sheets.functions.ts`.

- Aggregate distinct `(project_name, project_code)` pairs across the user's registered `sheet_rows` (looking at `canonical.project_name` / `canonical.project_code` and common extras keys like `Project Name`, `Project Code`).
- Render a simple table; no DB writes. Existing manual `projects` table is left alone for now.

---

## Technical notes

- All new server fns use `requireSupabaseAuth`; reads scoped through the existing user-scoped RLS on `sheet_registry`/`sheet_rows`.
- No new RLS policies needed besides the `sheet_registry.source_url` column (inherits existing policies).
- Bearer-token attacher is already wired (`attachSupabaseAuth` in `src/start.ts`).
- No new external secrets.

---

## Files touched

- migration: add `sheet_registry.source_url`
- edit: `src/routes/_authenticated/sheets.tsx`
- edit: `src/routes/_authenticated/dashboard.tsx`
- edit: `src/routes/_authenticated/projects.tsx`
- edit: `src/lib/sheets.functions.ts` (3 new fns)
- new: `src/lib/user-activity-match.ts`
- new: `src/components/DependentActivitiesTable.tsx`
- new: `src/components/DependencyDetailsDialog.tsx`

Ready to implement on approval.