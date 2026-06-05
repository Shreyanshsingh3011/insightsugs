## Goal

Turn the Alert details page into a read-only record with an admin "Send Alert" workflow that notifies the responsible person, project members, and assignees of dependent activities — via in-app notifications and email — and supports a reply thread plus a Resolve action.

## 1. Read-only alert details

- The Alert details page (`/alerts/$id`) is already display-only. Add an explicit "Read-only record" badge and confirm no input/textarea/contenteditable fields exist.
- Replies and Resolve live in a separate "Communication" panel below — not edits to the alert itself.

## 2. New database tables

- `alerts` — persisted dispatch record keyed by `flag_id` (string, e.g. `FLAG-001`). Stores snapshot of activity, stage, severity, source, root cause, reason, status (`open` / `acknowledged` / `resolved`), `sent_by`, `resolved_by`, `resolved_at`.
- `alert_recipients` — `alert_id`, `user_id` (nullable for external email-only), `email`, `channel` (`inapp` | `email`), `delivered_at`, `error`.
- `alert_messages` — thread: `alert_id`, `author_id`, `body`, `created_at`.

RLS: super_admin + admin can insert/update alerts; recipients + admins can read alerts/messages they're part of; recipients + admins can insert messages.

## 3. Recipient resolution

A server-side resolver builds the recipient set for a flag:

1. Responsible person — `flag.flagged_to.email` (+ matching `profiles.id` if found).
2. Project members — look up the activity by title/stage in `activities`, then read its `project_members`.
3. Dependent activity assignees — pull `activities` in the same project whose `depends_on` (or upstream/downstream link in the dep-chain resolver) touches the flagged activity; collect their `assignee_id`.

Deduped by email. External-only emails (no profile) still get email but no in-app row.

## 4. Server functions (`src/lib/alerts.functions.ts`)

- `sendAlert({ flagId })` — admin-only via `requireSupabaseAuth` + role check. Re-fetches the flag from the dashboard data, resolves recipients, upserts the `alerts` row, inserts `alert_recipients`, inserts a `notifications` row per in-app recipient, calls Lovable Emails `sendTransactionalEmail` per email recipient.
- `listAlerts()` — alerts visible to the current user (admin = all, others = where they are a recipient).
- `getAlert({ id })` — alert + recipients + messages.
- `replyToAlert({ alertId, body })` — recipient/admin inserts into `alert_messages`; pings other recipients in-app.
- `resolveAlert({ alertId })` — admin marks resolved.

## 5. Email template

New React Email template `src/lib/email-templates/alert-dispatch.tsx` rendering severity, activity, stage, root cause, reason, link back to `/alerts/{flagId}`. Registered in `src/lib/email-templates/registry.ts`. Sent via the existing `/lovable/email/transactional/send` route.

Prereq: if Lovable Emails infra / domain isn't set up yet, surface the email setup dialog first, then continue.

## 6. UI changes

- **Alert details (`/alerts/$id`)**:
  - "Read-only record" badge.
  - Admin-only **Send Alert** button (disabled once dispatched → shows "Dispatched · N recipients").
  - Recipients list (name/email · channel · delivered).
  - **Communication** panel: message thread, textarea + Send (any recipient/admin), **Resolve** button (admin), status pill.
- **Alerts list (`/alerts`)**: add "Dispatched" indicator column derived from `alerts` rows.
- **Navbar**: existing Alerts link unchanged.

## 7. Out of scope (this pass)

- SMS dispatch — deferred (requires Twilio connector + verified number). Will add as a follow-up once you confirm Twilio.

## Technical notes

- Admin check uses existing `public.is_admin_or_super(auth.uid())`.
- Dependent-activity expansion uses `activities.depends_on` when present, otherwise falls back to the dep-chain resolver output already wired in `src/lib/dependency-chain.ts` (best-effort, no failure if it can't map).
- In-app delivery writes to existing `notifications` table with `link = /alerts/{flagId}`.
- All writes routed through `createServerFn` + `requireSupabaseAuth`; no admin client in client code.
