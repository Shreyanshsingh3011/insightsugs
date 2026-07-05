
-- Step 4: Agent memory (long-lived facts the agent learns per user)
CREATE TABLE public.agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  importance SMALLINT NOT NULL DEFAULT 1,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_memory TO authenticated;
GRANT ALL ON public.agent_memory TO service_role;
ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own memory" ON public.agent_memory FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "service memory" ON public.agent_memory FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER trg_agent_memory_touch BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Step 5: multi-agent routing metadata on runs
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS routed_to TEXT;
ALTER TABLE public.agent_runs ADD COLUMN IF NOT EXISTS handoff_from TEXT;

-- Step 6: Evals — golden set + run results
CREATE TABLE public.eval_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected_tool TEXT,
  expected_substring TEXT,
  tags TEXT[],
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eval_cases TO authenticated;
GRANT ALL ON public.eval_cases TO service_role;
ALTER TABLE public.eval_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage eval cases" ON public.eval_cases FOR ALL TO authenticated
  USING (public.is_admin_or_super(auth.uid())) WITH CHECK (public.is_admin_or_super(auth.uid()));
CREATE POLICY "authenticated read eval cases" ON public.eval_cases FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_eval_cases_touch BEFORE UPDATE ON public.eval_cases
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES public.eval_cases(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  passed BOOLEAN NOT NULL,
  score NUMERIC,
  tool_called TEXT,
  output TEXT,
  error TEXT,
  latency_ms INT,
  tokens_in INT,
  tokens_out INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.eval_runs TO authenticated;
GRANT ALL ON public.eval_runs TO service_role;
ALTER TABLE public.eval_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage eval runs" ON public.eval_runs FOR ALL TO authenticated
  USING (public.is_admin_or_super(auth.uid())) WITH CHECK (public.is_admin_or_super(auth.uid()));
CREATE POLICY "authenticated read eval runs" ON public.eval_runs FOR SELECT TO authenticated USING (true);

-- Seed a small golden set
INSERT INTO public.eval_cases (name, prompt, expected_tool, tags) VALUES
  ('summary basic', 'Give me a summary of the current project', 'getDashboardSummary', ARRAY['analyst']),
  ('top delays', 'What are the top 5 delayed activities?', 'topDelays', ARRAY['analyst']),
  ('person workload', 'Why is the project behind for Rajesh?', 'getPersonWorkload', ARRAY['analyst']),
  ('open alerts', 'Show me open critical alerts', 'getOpenAlerts', ARRAY['analyst']),
  ('propose nudge', 'Nudge Rajesh about the pending drawings', 'proposeNudgeAssignee', ARRAY['scheduler']);
