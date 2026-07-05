
-- 1. agent_runs
CREATE TABLE public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent text NOT NULL,                     -- 'chatbot' | 'standup' | 'delay_root_cause' | 'doc_action_extractor' | ...
  trigger text NOT NULL DEFAULT 'manual',  -- 'manual' | 'cron' | 'hook' | 'chat'
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'running',  -- 'running' | 'succeeded' | 'failed'
  error text,
  tokens_in integer,
  tokens_out integer,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX agent_runs_agent_idx ON public.agent_runs (agent, created_at DESC);
CREATE INDEX agent_runs_actor_idx ON public.agent_runs (actor_id, created_at DESC);

GRANT SELECT ON public.agent_runs TO authenticated;
GRANT ALL ON public.agent_runs TO service_role;

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own runs"
  ON public.agent_runs FOR SELECT
  TO authenticated
  USING (actor_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

-- 2. pending_actions
CREATE TABLE public.pending_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  kind text NOT NULL,                      -- 'create_alert' | 'draft_email' | 'assign_activity' | 'schedule_standup'
  summary text NOT NULL,                   -- human-readable one-liner
  payload jsonb NOT NULL,                  -- exact tool args, ready to execute
  status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected' | 'executed' | 'failed'
  proposed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- user in whose chat session it was proposed
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- who should approve (nullable = any admin)
  decided_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  execution_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_actions_status_idx ON public.pending_actions (status, created_at DESC);
CREATE INDEX pending_actions_assigned_idx ON public.pending_actions (assigned_to, status);

GRANT SELECT, UPDATE ON public.pending_actions TO authenticated;
GRANT ALL ON public.pending_actions TO service_role;

ALTER TABLE public.pending_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see actions targeting them or that they proposed"
  ON public.pending_actions FOR SELECT
  TO authenticated
  USING (
    proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR assigned_to IS NULL
    OR public.is_admin_or_super(auth.uid())
  );

CREATE POLICY "Users decide on actions they can see"
  ON public.pending_actions FOR UPDATE
  TO authenticated
  USING (
    proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR assigned_to IS NULL
    OR public.is_admin_or_super(auth.uid())
  )
  WITH CHECK (
    proposed_by = auth.uid()
    OR assigned_to = auth.uid()
    OR assigned_to IS NULL
    OR public.is_admin_or_super(auth.uid())
  );

CREATE TRIGGER pending_actions_touch_updated_at
  BEFORE UPDATE ON public.pending_actions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. agent_preferences
CREATE TABLE public.agent_preferences (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key text NOT NULL,                       -- 'escalation_contact' | 'quiet_hours' | 'preferred_channel' | ...
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_preferences TO authenticated;
GRANT ALL ON public.agent_preferences TO service_role;

ALTER TABLE public.agent_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own preferences"
  ON public.agent_preferences FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TRIGGER agent_preferences_touch_updated_at
  BEFORE UPDATE ON public.agent_preferences
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
