# Show active environment data on the dashboard

Add a new dashboard card that surfaces the **currently active Emergent environment** and its live data, so everyone (not just super admins) can see which integration the app is running against and whether it is healthy.

## What the card shows

- **Active environment name** (e.g. "Production") + short ID badge (e.g. `prod`)
- **Live status**: green "Connected" / red "Down" pill from a fresh `/health` ping
- **Base URL host** (host only — e.g. `connector-flow-1.preview.emergentagent.com`), no API key
- **Last checked** timestamp + a "Refresh" button
- **Super admin only**: a "Manage" link to `/admin/integrations`
- If no environment is configured yet: a friendly empty state ("No live integration configured")

## Where it goes

- New widget on `src/routes/_authenticated/dashboard.tsx`, rendered at the top of the dashboard grid (above the existing widgets) so it's the first thing users see.
- It is a normal widget, visible to everyone — no role gating on visibility (only the "Manage" action is super-admin-only).

## How the data is fetched (technical)

1. **New public-safe server fn** `getActiveIntegrationStatus` in `src/lib/integrations.functions.ts`:
   - Uses `requireSupabaseAuth` (any signed-in user).
   - Loads the active env via the existing `loadRow` / `normalizeEnvs` helpers.
   - Calls the existing `pingEmergent()` (which already hits `/health`).
   - Returns a **safe DTO** only — no api_key, no full record:
     ```ts
     {
       configured: boolean,
       env: { id, name, base_url_host } | null,
       status: { ok, status, message, checkedAt } | null
     }
     ```
   - The host is extracted with `new URL(base_url).host` so we never leak query strings or paths.

2. **New component** `src/components/ActiveIntegrationCard.tsx`:
   - `useQuery` against the new server fn with `refetchInterval: 60_000` (auto-refresh every minute) and a manual Refresh button that calls `refetch()`.
   - Status pill driven by `status.ok` + `status.status`.
   - Uses `useRoles()` to conditionally show the "Manage" link.

3. **Dashboard wiring**: add an `"integration-status"` widget id in the dashboard's widget registry/grid so it renders at the top. No changes to user widget preferences are required — it's always-on like the existing header cards.

## Files touched

- `src/lib/integrations.functions.ts` — add `getActiveIntegrationStatus` (read-only, safe DTO).
- `src/components/ActiveIntegrationCard.tsx` — new component.
- `src/routes/_authenticated/dashboard.tsx` — render the new card.

## Out of scope (call out and confirm if needed)

- Rendering the **sheet data** from the active environment on the dashboard. That's a separate, larger change (pick a sheet, fetch via the active env, render as a table). If you also want that, say the word and I'll fold it in — otherwise this plan only surfaces the integration's own status/identity.
