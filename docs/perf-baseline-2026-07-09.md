# DelayLens Performance Baseline — 2026-07-09

Captured before Phase 1+3 refactor PR. Used as the reference for
comparison in `docs/perf-after.md` after optimization phases ship.

## Top slow queries (pg_stat_statements)

Ranked by total execution time across user schemas. Times in ms.

| # | Calls | Mean | Max | Total | Query (truncated) |
|---|------:|-----:|----:|------:|-------------------|
| 1 | 371   | 341.4 | 5003 | 126,665 | `INSERT ... sheet_row_embeddings ... ON CONFLICT (sheet_registry_id, row_index)` (HNSW maintenance) |
| 2 | 3,961 | 18.7  | 224  |  74,076 | `SELECT row_index, canonical, extras FROM sheet_rows WHERE sheet_registry_id = $1 ORDER BY row_index LIMIT ...` |
| 3 | 22    | 2842  | 5981 |  62,540 | Same embedding upsert as #1, larger batches |
| 4 | 3,845 | 13.9  | 123  | ~53,000 | (see slow_queries dump — sheet_rows read) |

### Hotspots

- **HNSW upsert cost dominates.** Embedding upserts (`sheet_row_embeddings`)
  account for ~190s of DB time and produce p99 stalls of 5+ seconds.
  Mitigation shipped in prior turn: chunk size reduced 200 → 25 with
  25ms inter-batch delay; blocking `await ensureSheetEmbeddings` removed
  from Copilot path; backfill runs in a 3-minute pg_cron.
- **`sheet_rows` paged reads** are frequent but individually cheap.
  Candidate for a covering index if p95 rises.

## Frontend baseline (informal — no RUM)

Measured against preview URL, dashboard route `/agent`, cold cache,
5 Mbps throttling, viewport 782x676:

- Dashboard TTI: ~3.2s
- Copilot first token p95: ~2.4s
- Sync poll interval: 300s (5 min); manual Sync button triggers immediate refetch
- Bundle: main + dashboard chunk ~ (not measured — run `bunx vite build` and record)

## Reliability baseline

- Sync fetch errors: recorded to `sheet_sync_audit` with `error` column (post prior turn)
- Server function errors: currently thrown as raw `Error(message)` — no consistent DTO
- Frontend catch sites: mixed `console.error` + toast; no central helper

## Targets (post-optimization)

| Metric | Baseline | Target |
|---|---|---|
| Dashboard TTI | 3.2s | −30% (~2.2s) |
| Copilot p95 first token | 2.4s | −25% (~1.8s) |
| Embedding upsert mean | 341ms | −60% via debounced coalesced queue |
| Sync duration (5-project run) | ~4-6s | −40% |

## How to re-measure

```bash
# Slow queries
# Use supabase--slow_queries tool

# Frontend TTI
bunx vite build && bunx vite preview
# then Playwright + performance.timing capture

# Bundle size
bunx vite build && du -sh .vinxi/build/client/assets/*.js | sort -h | tail
```
