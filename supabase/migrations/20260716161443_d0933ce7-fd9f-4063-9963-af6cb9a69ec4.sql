-- Drop unused HNSW index on sheet_row_embeddings.
-- pg_stat_user_indexes shows 0 scans in production while the b-tree
-- registry_idx handles all lookups. The HNSW index only added maintenance
-- overhead (INSERT/UPDATE cost, WAL, memory) with no query benefit.
DROP INDEX IF EXISTS public.sheet_row_embeddings_hnsw_idx;