-- One-off: kick embed-backfill (larger cap) and force-resync the stale site-verification sheet.
SELECT net.http_post(
  url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/embed-backfill?cap=5000',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 60000
);

SELECT net.http_post(
  url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/sheet-refresh-one',
  headers := jsonb_build_object(
    'Content-Type','application/json',
    'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
  ),
  body := jsonb_build_object('id','0d8d253f-bd9a-4cc9-98e8-089df4a20a69'),
  timeout_milliseconds := 60000
);
