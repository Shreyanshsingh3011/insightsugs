
-- Extend agent_runs with feedback + cost
ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS feedback smallint,
  ADD COLUMN IF NOT EXISTS feedback_note text,
  ADD COLUMN IF NOT EXISTS cost_credits numeric;

-- Extend pending_actions
ALTER TABLE public.pending_actions
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS rationale text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz;

-- Event log for analytics
CREATE TABLE IF NOT EXISTS public.agent_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  agent text NOT NULL,
  event text NOT NULL,
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  action_id uuid REFERENCES public.pending_actions(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.agent_run_events TO authenticated;
GRANT ALL ON public.agent_run_events TO service_role;

ALTER TABLE public.agent_run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own events select" ON public.agent_run_events
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

CREATE POLICY "own events insert" ON public.agent_run_events
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid() OR actor_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_actor_created
  ON public.agent_run_events (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_run_events_agent_created
  ON public.agent_run_events (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_created
  ON public.agent_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_actor_created
  ON public.agent_runs (actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pending_actions_status_created
  ON public.pending_actions (status, created_at DESC);
