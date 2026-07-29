select cron.schedule(
  'weekly-briefing-monday',
  '30 6 * * 1',
  $$
      SELECT net.http_post(
        url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/weekly-briefing',
        headers := jsonb_build_object('Content-Type','application/json','Authorization',  'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key') ),
        body := '{}'::jsonb
      );
  $$
);