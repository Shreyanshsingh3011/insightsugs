## Goal
Make the Dependency Chain panel always derive mapping from the actual sheet rows you point it at, using a clear dependency rule, with no Emergent resolver step.

## Changes

### 1. `src/lib/dependency-inference.ts`
- Update `DEFAULT_LOGIC` so the rule is explicit: each row's `Sr. No.` depends on the id(s) in `Dependent activities`. Edge direction = **from dependency → to current row** (i.e. `Dependent activities` value → `Sr. No.`), so the topo order reads as "do prerequisites first".
- Split the cell on `,`, `;`, whitespace, and `/` so multi-id cells still work.
- Carry `label` per node = `Process Descriptions` (truncated to ~60 chars) into the response so the graph can render it.
- Add an optional `nodeLabels: Record<string,string>` field on the returned `DependencyChainResponse` (extend the type).

### 2. `src/lib/dependency-chain.ts`
- Extend `DependencyChainResponse` with optional `nodeLabels?: Record<string, string>`.
- No other changes.

### 3. `src/routes/index.tsx` — `DependencyChainPanel`
- Drop the two-mode tabs. Single panel:
  - One input: **Sheet URL** (Apps Script `/exec` or any public JSON), persisted to `localStorage` (`dependency.sheet.v1`).
  - Collapsible "Advanced logic" `<details>` with the editable JS textarea (still persisted), defaulting to the new rule. Most users never open it.
  - Buttons: **Resolve** (re-runs) and **Reset logic**.
- Auto-run on mount when a saved sheet URL exists (`enabled: !!sheetUrl`).
- Remove `RESOLVER_KEY`, `activeResolver`, `loadDependencyChain` import, and all resolver-mode UI.
- Pass `data.nodeLabels` into `chainToActivities` so each node shows its `Process Descriptions` instead of the raw `Sr. No.`.
- Empty-state hint when no URL is saved: "Paste your Apps Script web app URL to map dependencies from your sheet."

### 4. `src/components/DependencyFlow.tsx`
- Already renders `description` per node; just ensure `chainToActivities` populates `description` from `nodeLabels[id]` (falling back to the node id). No component-internal change expected — verify and adjust only if needed.

### 5. `chainToActivities` (in `src/routes/index.tsx`)
- Use `data.nodeLabels?.[node] ?? node` for `description`; keep `uid`/`id` as the Sr. No.; build `dependsOn` from `directEdges` as before.

## Edge cases handled
- Sheet URL returns an array, `{ data: [...] }`, or `{ rows: [...] }` — already handled in `fetchSheet`.
- `Dependent activities` is `null`/`""` → row contributes a node but no incoming edge.
- Cell with multiple ids (`"2, 3"`) → multiple edges.
- Self-reference or unknown id → still added as edge; cycles surface via `isDAG: false` in the existing stats line.
- CORS: Apps Script `/exec` deployed "Anyone" supports CORS GET; if the user's URL blocks CORS we surface the fetch error in the existing red error line (no silent failure).

## Out of scope
- Server-side proxy for non-CORS sheet URLs.
- Editing the dependency rule per-row in the UI.
- Persisting graph layout.
