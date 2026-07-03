
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any prior schedule with this name, then (re)create.
DO $$
BEGIN
  PERFORM cron.unschedule('agent-watchers-scan');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'agent-watchers-scan',
  '17 */6 * * *',  -- every 6 hours at :17
  $cron$
  SELECT net.http_post(
    url := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/agent-watchers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzZmRudXl0eHdla3R3ZW1oYXp5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNjIzOTUsImV4cCI6MjA5NTYzODM5NX0.rKB9Jonttb8bwgtxC2whJLQfEmX0d7iYEYEs_AIB3uU'
    ),
    body := '{"source":"pg_cron"}'::jsonb
  );
  $cron$
);
