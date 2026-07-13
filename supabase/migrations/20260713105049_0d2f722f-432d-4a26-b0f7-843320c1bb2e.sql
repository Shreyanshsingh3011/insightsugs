SELECT cron.unschedule('sheets-refresh-2min');
SELECT cron.schedule(
  'sheets-refresh-2min',
  '*/2 * * * *',
  $cron$ SELECT net.http_post(
    url:='https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/sheets-refresh',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:='{}'::jsonb
  ); $cron$
);