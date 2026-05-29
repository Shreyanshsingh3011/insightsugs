## Why they're hidden

`superadmin@test.com` does have the `super_admin` role in the database — I verified that. The links aren't being filtered out by role; they're filtered out by **viewport**.

In `src/routes/_authenticated.tsx`:

- The full sidebar (lines 39–60) is `hidden md:flex` — only visible at ≥ 768px.
- The mobile top bar (lines 64–69) is `md:hidden` and only renders **Dashboard / My activities / Inbox / Settings**. The admin-gated links (Projects, Holidays, Users, Audit) are not in that mobile list at all.

Your preview viewport is 768×582 with devicePixelRatio 1.25, which puts the layout in the mobile branch most of the time — so the admin links never render even though your role is correct.

## Fix

Add the same role-gated links to the mobile nav, so a super_admin sees all five items regardless of screen size.

Edit `src/routes/_authenticated.tsx`, mobile `<nav>` block (lines 64–69), to include:

```text
- Dashboard
- My activities
- Inbox
- Projects        (isAdmin)
- Holidays        (isAdmin)
- Users           (isSuper)
- Audit           (isAdmin)
- Settings
```

The mobile bar already scrolls horizontally (`overflow-x-auto`), so the extra items fit fine.

No DB, RLS, or role-logic changes are needed.