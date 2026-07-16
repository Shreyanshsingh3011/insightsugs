
SELECT cron.unschedule('oneshot-vacuum-bloat');

ALTER TABLE public.sheet_rows SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 500,
  autovacuum_vacuum_cost_limit = 2000,
  autovacuum_vacuum_cost_delay = 2
);

ALTER TABLE public.sheet_row_embeddings SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 500,
  autovacuum_vacuum_cost_limit = 2000,
  autovacuum_vacuum_cost_delay = 2
);

-- Plain VACUUM (not FULL) is allowed in a txn block and marks dead tuples
-- reusable so future writes don't extend the file further.
SELECT cron.schedule(
  'oneshot-vacuum-plain',
  '* * * * *',
  $cron$
  DO $body$
  BEGIN PERFORM cron.unschedule('oneshot-vacuum-plain'); END
  $body$;
  VACUUM (ANALYZE) public.sheet_rows;
  VACUUM (ANALYZE) public.sheet_row_embeddings;
  $cron$
);
