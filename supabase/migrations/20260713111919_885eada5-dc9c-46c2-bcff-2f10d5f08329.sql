
-- 1) integration_health observability table
CREATE TABLE IF NOT EXISTS public.integration_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','degraded','down')),
  latency_ms integer,
  error text,
  meta jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_health_name_time ON public.integration_health (name, checked_at DESC);

GRANT SELECT ON public.integration_health TO authenticated;
GRANT ALL ON public.integration_health TO service_role;

ALTER TABLE public.integration_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated can read integration_health"
  ON public.integration_health FOR SELECT TO authenticated USING (true);

-- 2) Sheet-level degraded/backoff flag
ALTER TABLE public.sheet_registry
  ADD COLUMN IF NOT EXISTS degraded_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_row_hash_sample text;

-- 3) Add pending_actions + alerts to realtime publication
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_actions;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

ALTER TABLE public.pending_actions REPLICA IDENTITY FULL;
ALTER TABLE public.alerts REPLICA IDENTITY FULL;
