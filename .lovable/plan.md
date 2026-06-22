# Co-pilot Notebook — Source-Grounded, Verified-Accuracy

A new Co-pilot experience inside the Insights page that replaces the current chat tab. Math is done in JS (authoritative). Gemini (`gemini-flash-latest`, free tier) only narrates qualitative answers or rephrases computed numbers. All chat state lives in **our** Supabase, not DelayBridge.

---

## 1. Backend (Supabase)

### Migration — two new tables
- `notebook_sources(id, token, type ∈ {sheet,concerns,reminders}, label, enabled bool default true, summary text, summary_generated_at, row_count int, unique(token,type,label))`
- `notebook_messages(id, token, role, content, citations jsonb default '[]', generated_by, created_at)`
- RLS enabled; permissive policy for `anon` + `authenticated` (access is gated by the opaque DelayBridge token in app logic).
- GRANTs for `anon`, `authenticated`, `service_role`.

### Secret
- Request `GEMINI_API_KEY` via `add_secret`.

### Edge function `copilot-notebook` (Deno, `verify_jwt=false`)
Reads `GEMINI_API_KEY` from env. Three modes via `{ mode }` in body:

- **`chat`** — `{ token, question, mode_hint, computed_result?, context_items?, history }`
  - If `computed_result` present → prompt Gemini to **only phrase** that exact value; never alter numbers. `generated_by:"computed"` (or `"computed+ai"` when phrased).
  - Else (qualitative) → strict system prompt: *"Answer ONLY from the provided context items. Append `[[…]]` tag after each factual claim. If absent, say 'That isn't in the selected sources.' Never invent figures."* Send `context_items + history + question` to `gemini-flash-latest:generateContent`.
  - Server parses `[[…]]` tags → `citations[]`, strips tags from text, persists user + assistant rows to `notebook_messages`, returns `{ text, citations, generated_by }`.
  - On Gemini failure → return extractive fallback (top context items concatenated) with `generated_by:"computed"` and never 500.
- **`summarize_source`** — `{ token, type, label, sample }` → 2–3 sentence factual summary; upsert into `notebook_sources` with `row_count`, `summary_generated_at`.
- **`suggest_questions`** — `{ token, enabled_sources, schema_info }` → 4–6 starter questions grounded in actual column names.

---

## 2. Client — Question Router (pure JS, no LLM)

New `src/lib/notebook/router.ts`:
- **Classify** by regex on intent verbs: how many, count, number of, total, sum, average/mean, max/min, highest/lowest, most/least, per X, group by, "% of", compare. → `quantitative` vs `qualitative`.
- **Parse** quantitative into `{ agg: sum|count|avg|min|max|argmax|groupCount, column?, filter?, groupBy? }` by fuzzy-matching tokens against the union of column names across enabled sheets + `concerns`/`reminders` field names.
- **Compute** in `src/lib/notebook/compute.ts` over enabled sources' full row arrays:
  - Skip rows whose first-column value matches `/^(grand\s*total|sub\s*total|total)$/i`.
  - Numeric coercion: strip commas/currency, `parseFloat`, ignore `NaN`/empty.
  - Returns `{ value, formatted, contributingRows: [{sheetLabel,rowIndex}, …] }`.
- If parsing fails → treat as qualitative.

## 3. Client — Retrieval (qualitative path)

`src/lib/notebook/retrieve.ts`:
- Tokenize question (lowercase, strip stopwords).
- Score each row: `Σ overlap(token, cellValue|columnName)` with small boost for exact phrase.
- Always include **all** concerns + reminders when those sources are enabled.
- Cap at 40 items; tag each:
  - Sheet row → `[[Sheet:<label>|row:<i>]] col=val; …`
  - Concern → `[[Concern:<id>]] title=…; status=…; target_department=…; detail=…`
  - Reminder → `[[Reminder:<id>]] subject=…; status=…; recipient=…; schedule_at=…`

## 4. Client — Citation Verification

`src/lib/notebook/verify.ts`: for each returned citation, confirm the referenced sheet row / concern / reminder exists in current enabled data and that any numeric/string value mentioned in the sentence appears in that record. Unverified citations are dropped (or rendered greyed-out).

## 5. Frontend — Co-pilot Tab Rewrite

Replace the existing Copilot section inside `src/components/InsightDashboard.tsx` with a new `<NotebookCopilot/>` component (`src/components/notebook/NotebookCopilot.tsx`) wired into the existing tab.

Layout (two-column on desktop, stacked on mobile):

```text
┌──────────── Sources ─────────────┬──────────────── Chat ────────────────┐
│ [x] Sheet: Cabling   (124 rows) │ Suggested: [chip][chip][chip][chip]   │
│     summary…  [Regenerate]      │ ─────────────────────────────────────  │
│ [x] Sheet: Poles     ( 88 rows) │  user: …                              │
│     summary…                    │  assistant [Computed]  total = 1,000…  │
│ [x] Concerns         (  2)      │     ↳ [Sheet:Cabling row 14] chip      │
│ [ ] Reminders        (  1)      │  assistant [AI] explanation…           │
│                                 │     ↳ [Concern #abc] chip              │
│                                 │  [textarea] [Send]                     │
└─────────────────────────────────┴───────────────────────────────────────┘
```

Behavior:
- Sources list built from `dashboard.sheets[]` + `concerns` + `reminders` returned by DelayBridge link. Toggle persists to `notebook_sources.enabled` (upsert).
- "Generate summary" calls edge fn `summarize_source` (cached; regenerate only on click or `row_count` change).
- Suggested-question chips loaded from `suggest_questions`; refresh when enabled set changes.
- On send:
  1. Router classifies.
  2. If quantitative → compute locally → POST `chat` with `computed_result` + `contributingRows` → render with **Computed** badge.
  3. If qualitative → build context_items → POST `chat` → verify citations → render with **AI** badge.
- Citation chips clickable: sheet-row → switch to Sheets tab, scroll & flash row; concern → open the existing concern card / dialog.
- History loaded from `notebook_messages` on mount (filtered by token).
- If `GEMINI_API_KEY` missing, edge fn returns `offline:true` → banner: *"Running in offline mode — numeric answers are exact; set GEMINI_API_KEY for full AI explanations."*

## 6. Files

New:
- `supabase/migrations/<ts>_notebook.sql`
- `supabase/functions/copilot-notebook/index.ts`
- `src/lib/notebook/{router,compute,retrieve,verify,client}.ts`
- `src/components/notebook/{NotebookCopilot,SourcesPanel,ChatPanel,CitationChip}.tsx`

Edited:
- `src/components/InsightDashboard.tsx` — swap Copilot tab content for `<NotebookCopilot/>`; expose imperative "jump to sheet row" handle.

## 7. Secrets / setup actions needed from user
- Approve the migration.
- Provide `GEMINI_API_KEY` (free key from Google AI Studio) via secure secret form.

## 8. Acceptance checks (manual)
1. `total Quantity` → exact JS sum + Computed badge + row citations.
2. `how many in Service Group X` → exact count.
3. `which Sch has most line items` → exact argmax.
4. Toggle Concerns off/on → answer source changes accordingly.
5. Out-of-source question → "That isn't in the selected sources."
6. Unset key → questions 1–3 still exact; banner shows.
7. Every citation chip resolves to a matching row/concern.
