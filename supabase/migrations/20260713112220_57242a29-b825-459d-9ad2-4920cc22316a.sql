
DO $$
BEGIN
  PERFORM cron.unschedule('ai-health-hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ai-health-hourly',
  '0 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/ai-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzZmRudXl0eHdla3R3ZW1oYXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNjIzOTUsImV4cCI6MjA5NTYzODM5NX0.rKB9Jonttb8bwgtxC2whJLQfEmX0d7iYEYEs_AIB3uU'
    ),
    body := '{}'::jsonb
  );
  $$
);
