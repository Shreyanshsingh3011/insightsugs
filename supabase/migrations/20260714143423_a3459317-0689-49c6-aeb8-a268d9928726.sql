-- Reschedule the 5 pg_cron webhooks to authenticate with the service role
-- key from vault instead of the public anon key. The hook route now rejects
-- anon-key requests, so this keeps the scheduled jobs working.
--
-- We reuse the existing `email_queue_service_role_key` vault entry (also used
-- by email_queue_dispatch), avoiding a new secret round-trip.

DO $$
DECLARE
  base_url text := 'https://project--45301998-f1e7-47ef-820f-cdd915a032cb.lovable.app';
  auth_expr text := $x$ 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key') $x$;
BEGIN
  -- Only touch jobs that exist; skip silently if a job was removed.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sheets-refresh-2min') THEN
    PERFORM cron.unschedule('sheets-refresh-2min');
    PERFORM cron.schedule('sheets-refresh-2min', '*/2 * * * *', format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %s),
        body := '{}'::jsonb
      );
    $cmd$, base_url || '/api/public/hooks/sheets-refresh', auth_expr));
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-health-hourly') THEN
    PERFORM cron.unschedule('ai-health-hourly');
    PERFORM cron.schedule('ai-health-hourly', '0 * * * *', format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %s),
        body := '{}'::jsonb
      );
    $cmd$, base_url || '/api/public/hooks/ai-health', auth_expr));
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'embed-backfill-tick') THEN
    PERFORM cron.unschedule('embed-backfill-tick');
    PERFORM cron.schedule('embed-backfill-tick', '*/3 * * * *', format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %s),
        body := '{}'::jsonb
      );
    $cmd$, base_url || '/api/public/hooks/embed-backfill?cap=2000', auth_expr));
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'infra-digest-weekly') THEN
    PERFORM cron.unschedule('infra-digest-weekly');
    PERFORM cron.schedule('infra-digest-weekly', '0 7 * * 1', format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %s),
        body := '{}'::jsonb
      );
    $cmd$, base_url || '/api/public/hooks/infra-digest', auth_expr));
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'openrouter-model-health-nightly') THEN
    PERFORM cron.unschedule('openrouter-model-health-nightly');
    PERFORM cron.schedule('openrouter-model-health-nightly', '15 2 * * *', format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Content-Type','application/json','Authorization', %s),
        body := '{}'::jsonb
      );
    $cmd$, base_url || '/api/public/hooks/model-health', auth_expr));
  END IF;
END $$;
