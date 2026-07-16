
-- 1) Loosen cron.
SELECT cron.unschedule('sheets-refresh-2min');
SELECT cron.unschedule('embed-backfill-tick');

SELECT cron.schedule(
  'sheets-refresh-2min',
  '*/30 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/sheets-refresh',
    headers := jsonb_build_object('Content-Type','application/json','Authorization',  'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key') ),
    body := '{}'::jsonb
  );
  $cron$
);

SELECT cron.schedule(
  'embed-backfill-tick',
  '0 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/embed-backfill?cap=2000',
    headers := jsonb_build_object('Content-Type','application/json','Authorization',  'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key') ),
    body := '{}'::jsonb
  );
  $cron$
);

-- 2) One-shot VACUUM FULL via pg_cron, which runs each command in its own
--    autocommit session (so the "no txn block" rule doesn't apply). The job
--    unschedules itself after running once.
SELECT cron.schedule(
  'oneshot-vacuum-bloat',
  '* * * * *',
  $cron$
  DO $body$
  BEGIN
    -- unschedule first so we only run once even if the VACUUMs are slow
    PERFORM cron.unschedule('oneshot-vacuum-bloat');
  END
  $body$;
  VACUUM (FULL, ANALYZE) public.sheet_rows;
  VACUUM (FULL, ANALYZE) public.sheet_row_embeddings;
  $cron$
);
