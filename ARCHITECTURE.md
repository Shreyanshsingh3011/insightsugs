# Architecture

A project-delay intelligence platform for SUGS Lloyd. It ingests live construction /
utility project sheets, derives delay signals from them, surfaces those signals on a
dashboard, and lets an LLM agent answer questions and propose actions — always grounded
in the exact rows it read.

This document is the map. Every module also carries a header comment explaining its own
role; start here, then read the file.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start v1 (React 19, file-based routing, SSR) |
| Build | Vite 7, deployed to a Cloudflare Workers-style edge runtime |
| Styling | Tailwind CSS v4 via `src/styles.css` (`@theme` tokens, no `tailwind.config.js`) |
| UI kit | shadcn/ui in `src/components/ui` (generated — do not hand-edit) |
| Backend | Lovable Cloud (Postgres + Auth + Storage + RPC), accessed through the generated client in `src/integrations/supabase` |
| Server logic | `createServerFn` from `@tanstack/react-start`; raw HTTP only under `src/routes/api` |
| AI | Lovable AI Gateway (OpenAI-compatible) with a Gemini fallback path |
| Tests | Vitest (`src/lib/__tests__`) plus standalone scripts in `scripts/tests` |

### Hard constraints

- **No other router.** TanStack Router is fixed; there is no `src/App.tsx` or `src/pages`.
- **`src/routeTree.gen.ts` is generated.** Never edit it.
- **`src/integrations/supabase/*` is generated** (`client.ts`, `client.server.ts`,
  `types.ts`, `auth-middleware.ts`, `auth-attacher.ts`). Never edit them.
- **Edge runtime.** Server code must avoid Node-only packages (`child_process`, `sharp`,
  native addons). Read `process.env.*` *inside* a handler, never at module scope.
- **`*.server.ts` files are blocked from the client bundle by filename.** Anything a
  component imports must live in a client-safe path (`*.functions.ts`, plain `*.ts`).

---

## 2. Directory map

```
src/
  routes/                    file-based routes; path === filename
    __root.tsx               html shell, providers, <Toaster/>, global head
    index.tsx                public landing
    login.tsx                auth entry
    _authenticated.tsx       auth gate — redirects to /login, renders <Outlet/>
    _authenticated/          every signed-in page (dashboard, agent.*, admin.*, ...)
    api/chat.ts              the dashboard chatbot streaming endpoint
    api/agent/plan.ts        multi-step planner (streamObject; proposal-only)
    api/public/**            unauthenticated HTTP: cron ticks + external webhooks
    lovable/email/**         platform email queue / preview / suppression hooks

  lib/
    *.functions.ts           createServerFn RPC — safe for components to import
    *.server.ts              server-only helpers — never imported by components
    *.ts                     pure, isomorphic logic (matching, formatting, scoring)
    notebook/                the standalone notebook copilot (separate data pool)
    email-templates/         React email templates + registry
    __tests__/               Vitest suites

  components/                app components (ui/ is shadcn-generated)
    copilot/                 citation chips, grounding trace, teach dialog
    ai-elements/             chat primitives (message, conversation, prompt input)

  hooks/                     shared React hooks (sources, scope, session, theme, ...)
  integrations/supabase/     generated clients + auth middleware
  styles.css                 Tailwind v4 theme tokens (all colors live here)

supabase/                    migrations + the copilot-notebook edge function
scripts/tests/               RLS, citation-contract and routing regression scripts
```

---

## 3. Data flow

```
Google Sheets (5 project sources)
        │  CSV export / connector fallback
        ▼
 insights-proxy.functions.ts ──► sheet_registry + sheet_rows (Postgres)
        │                              │
        │ useAgentSources()            │ copilot-index / embeddings
        ▼                              ▼
 dashboard-data.ts ──► KPIs      doc_chunks (pgvector)
 status-utils.ts  ──► ETA/done          │
 row-quality.ts   ──► validation        │
        │                               │
        ▼                               ▼
 AgentDashboard, /alerts, /agent/*   Copilot retrieval + citations
```

**Sheets are the source of truth, not the database.** The DB is a cache plus an audit
trail. The dashboard refetches sources on mount with no `staleTime` so KPI pages never
show a stale snapshot; the server-side refresh runs on its own cron cadence.

### Key derivations

- `status-utils.ts` — `isRowEffectivelyDone` and the rolling-velocity ETA model
  (`remaining / (completions per day)`, windowed 30d → 60d → 90d → all-time).
  It also defends against **date-serial leaks**: sheets sometimes emit a raw Excel serial
  (~46 000) where a duration belongs, which is why durations are sanity-clamped.
- `row-quality.ts` — flags leaked serials and missing TAT/Days-Taken fields, and
  produces auto-fix suggestions.
- `entity-scope.ts` — `normIdent` / `normSrNo` normalization so a dashboard card still
  resolves its rows when a project name or serial drifts in punctuation or spacing.
- `agent-flag-builder.ts` — turns live sheet rows into the alert flags shown on
  `/alerts`, so alerts and the dashboard always agree.

---

## 4. The AI layer

There are **two distinct assistants**. Do not merge them.

### Dashboard chatbot — `src/routes/api/chat.ts`

Streams via AI SDK `streamText` in a tool-calling loop. It is hard-scoped to dashboard
data by `DASHBOARD_TOOL_ALLOWLIST` plus a `FORBIDDEN_TOOL_PATTERN` guard, so it cannot
reach Copilot document tools even if the model asks.

### Copilot — `src/lib/copilot-agent.functions.ts`

Answers from selected sheet sources with mandatory citations. Its pipeline:

1. **Verb + column resolution** — `copilot-verb-lexicon.ts` detects intent
   (breakdown, find, compare…); `query-match.ts::resolveColumnReference` scores columns
   Exact > Normalized > Token-subset > Fuzzy, with a conservative stemmer and typo
   tolerance.
2. **Learned synonyms** — user-taught term/phrase mappings in `copilot_synonyms`
   (`TeachCopilotDialog`).
3. **Clarify-first** — when the question is ambiguous, `copilot-clarify.server.ts` ranks
   options by semantic similarity and column popularity, asks, then stores the choice as
   a session preference in `copilot_clarify_sessions`.
4. **Deterministic path** — `copilot-deterministic.server.ts` answers pure stats without
   an LLM call at all.
5. **Grounding** — the exact-match guardrail refuses similar-but-different records; the
   pin-to-cell rule makes every citation point at a real row/column, verified before it
   is shown. Rendered by `GroundingTracePanel` and `CitationChips`.

### Model routing

`ai-gateway.server.ts` builds an OpenAI-compatible provider against the Lovable AI
Gateway. `ai-fallback.server.ts` wraps `fetch` so payment/credit/rate errors transparently
retry on a Gemini model. `src/lib/notebook/` is a **separate pool** — its uploaded sources
never feed the dashboard, and dashboard sources never feed it.

---

## 5. Agent autonomy

`pg_cron` calls the public hooks under `src/routes/api/public/hooks/*`:

| Hook | Cadence | Purpose |
|---|---|---|
| `sheets-refresh` / `sheet-refresh-one` | frequent | pull sheets into `sheet_rows` |
| `agent-tick` | recurring | escalation ladder at 6h / 12h / 24h for unapproved proposals |
| `agent-watchers` | recurring | auto-dismiss flags whose underlying row resolved |
| `daily-standup`, `infra-digest`, `model-health` | daily | digests and health probes |
| `weekly-briefing` | Mon 06:30 | org + per-project briefing, exportable to PDF/DOCX |

Proposals never execute themselves: they land in `pending_actions` and require approval
(`/agent/approvals`). Runs are recorded through `agent-runs.server.ts` with
overlapping-run protection.

**Every `/api/public/*` route bypasses site auth.** Each handler must verify its own
caller — signature, shared secret, or `hook-auth.server.ts`.

---

## 6. Auth, roles and security

- Auth gate: `src/routes/_authenticated.tsx`. Protected server functions use
  `.middleware([requireSupabaseAuth])`; `src/start.ts` attaches the bearer token
  client-side.
- **Never call a protected server function from a public route's loader** — SSR and
  prerender have no session and it will 401 the build.
- Roles live in `public.user_roles` (`super_admin` / `admin` / `user`), never on
  `profiles`, and are checked through the `has_role` SECURITY DEFINER function.
  `src/lib/route-guards.ts` reads them client-side for UI gating only — never as the
  authorization decision.
- Every public table has RLS enabled plus explicit `GRANT`s. Notebook tables have **no**
  direct grants; all access goes through capability-token SECURITY DEFINER RPCs.
- `safe-handler.server.ts` wraps handlers to return `{ ok, data | error }` instead of
  leaking raw provider errors across the RPC boundary.

---

## 7. Conventions

- **Colors are semantic tokens in `src/styles.css`.** Never write `text-white`,
  `bg-black`, or `bg-[#...]` in a component — it breaks theming and dark mode.
- Server functions live in thin wrapper files: imports, types, exported
  `createServerFn` declarations only. Runtime helpers move to an imported module or
  inside the handler, or the build's function-splitting pass will delete them.
- Data loading prefers a route loader with `ensureQueryData` + `useSuspenseQuery`,
  not `useEffect` fetching.
- Every content route defines its own `head()` with a unique title and description.
- Browser-only libraries are dynamically imported behind `<ClientOnly>`; a static import
  still runs during SSR.

## 8. Testing

```bash
bun run test              # full Vitest suite
bun run test:accuracy     # ETA + accuracy pipeline
bun run test:rls          # role/RLS regression
bun run test:citations    # citation contract
bunx tsgo --noEmit        # typecheck
```

CI runs the accuracy suite on push (`.github/workflows/accuracy-tests.yml`) and a deeper
nightly pass (`accuracy-nightly.yml`).
