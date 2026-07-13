DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sheet_rows;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_drafts;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sheet_registry;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
ALTER TABLE public.sheet_rows REPLICA IDENTITY FULL;
ALTER TABLE public.agent_drafts REPLICA IDENTITY FULL;

SELECT cron.unschedule('sheets-refresh-5min');
SELECT cron.schedule(
  'sheets-refresh-2min',
  '*/2 * * * *',
  $cron$ SELECT net.http_post(
    url:='https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app/api/public/hooks/sheets-sync',
    headers:='{"Content-Type":"application/json"}'::jsonb,
    body:='{}'::jsonb
  ); $cron$
);