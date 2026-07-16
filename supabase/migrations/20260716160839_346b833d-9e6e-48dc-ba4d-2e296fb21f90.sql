
-- 1) Reschedule high-frequency crons
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'sheets-refresh-2min' LOOP
    PERFORM cron.alter_job(job_id := r.jobid, schedule := '*/10 * * * *');
  END LOOP;
  FOR r IN SELECT jobid FROM cron.job WHERE jobname = 'embed-backfill-tick' LOOP
    PERFORM cron.alter_job(job_id := r.jobid, schedule := '*/10 * * * *');
  END LOOP;
END $$;

-- 2) Drop redundant / unused indexes (cuts per-insert overhead on sheet_rows)
DROP INDEX IF EXISTS public.sheet_rows_reg_idx;                    -- duplicated by unique (registry_id,row_index)
DROP INDEX IF EXISTS public.idx_sheet_rows_canonical_activity_lower; -- 0 scans since boot

-- 3) Notifications: covering index for the per-user recent-list query
CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
  ON public.notifications (user_id, created_at DESC);
