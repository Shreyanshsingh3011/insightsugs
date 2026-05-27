## Goal

Make the existing `DependencyChainPanel` in `src/routes/index.tsx` a fully dynamic engine: Apps Script URL + pasted JS mapping logic → resolves dependencies → renders a Task+Assignee-only React Flow graph, analysis cards, and feeds the DelayLens Copilot.

Most plumbing already exists (sheet fetch, `new Function` execution, `DependencyFlow`, localStorage). This plan fills the gaps.

## Changes

### 1. `src/lib/dependency-inference.ts` — support two logic shapes

Today the pasted logic must return `{ edges, labels }`. Add support for the mapping-style shape the user describes:

```js
return {
  taskColumn: "Task Name",
  assignedColumn: "Assigned To",
  dependencyColumn: "Depends On",
  statusColumn: "Status",
  delayColumn: "Delay Days"
}
```

After running `new Function(...)`:
- If result has `edges` → use existing path.
- If result has `taskColumn` (mapping shape) → derive edges internally: each row's task depends on ids/names listed in `dependencyColumn` (use `helpers.splitIds`). Build `nodeLabels` from `taskColumn`, and a new `nodeMeta: Record<string, { task, assignee, status, delay }>` from the mapped columns.

Extend `DependencyChainResponse` (in `src/lib/dependency-chain.ts`) with optional `nodeMeta` and keep the existing `nodeLabels`.

Update `DEFAULT_LOGIC` to the mapping example above (user-facing default), keeping the advanced `edges` form documented in a comment.

### 2. `src/routes/index.tsx` — UI polish on `DependencyChainPanel`

- Promote the dependency logic editor out of `<details>` so it is always visible below the URL field.
- Style as a "VS Code terminal" block: dark `bg-[#0b1020]`, mono font, cyan neon border using `shadow-[0_0_0_1px_rgb(34,211,238),0_0_24px_-4px_rgb(34,211,238)]` and a top bar with "● ● ●" dots + label `DEPENDENCY LOGIC (PASTE FROM EMERGENT)`.
- Field 1 label updated to `SHEET URL (APPS SCRIPT WEB APP OR PUBLIC JSON)`.
- Keep Resolve / Refresh / Reset behavior and localStorage keys (`dependency.sheet.v1`, `dependency.logic.v1`).

### 3. `src/components/DependencyFlow.tsx` — Task + Assignee only

Confirm/adjust the node renderer so each node shows two lines:
- Line 1: Task Name (bold)
- Line 2: `Assigned: <name>` (muted)

No dates, status, IDs, or raw JSON in the graph. `chainToActivities` in `index.tsx` will pass `description = task` and a new `assignee` field sourced from `nodeMeta`.

### 4. New analysis cards (in `DependencyChainPanel`)

Compute from `chain` + `nodeMeta`:
- **Top Blocker** — node with max `descendants.length` (most downstream tasks waiting).
- **Critical Chain** — longest path through the DAG (DFS on topo order).
- **At Risk Tasks** — nodes whose any ancestor has `status !== "Done"` or `delay > 0`.
- **Most Delayed Person** — group `nodeMeta` by assignee, sum `delay`, pick max.

Render as a 4-card grid above the graph with a one-line human insight, e.g.
`"Electrical Work is delayed because Survey Work (Ajay) is pending for 12 days."`

### 5. Copilot integration

In `askChatbot` call site (line ~674), include a compact dependency context when available: pass `{ chain: data.chain, nodeMeta, topBlocker, criticalChain }` via the existing extras/context channel so the assistant can answer:
- Why is this task delayed?
- Who is blocking task X?
- Which dependency chain is critical?
- Show all tasks dependent on X
- Which employee is causing highest delay?

Store the latest resolved chain in a module-level ref or lift it to `Dashboard` state so the chat panel can read it. No server changes required — context is appended to the user message payload.

### 6. Persistence

Already handled. Verify both keys load on mount and the resolved chain auto-runs via `useQuery({ enabled: !!savedSheet })`.

## Technical notes

- `new Function` sandbox stays client-side; no eval on server.
- `splitIds` already accepts `, ; | / whitespace` separators.
- React Flow is already wired through `DependencyFlow`; no new deps.
- No Monaco — a styled `<textarea>` with the neon shell meets the "VS Code style" bar without adding ~2MB of bundle.

## Out of scope

- Real Monaco editor (textarea-with-chrome instead).
- Server-side resolver (kept fully client-side).
- Editing sheet data from the dashboard.
