
CREATE TABLE public.custom_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  tool_allowlist TEXT[] NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  webhook_secret TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  webhook_enabled BOOLEAN NOT NULL DEFAULT false,
  last_run_at TIMESTAMPTZ,
  run_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_agents TO authenticated;
GRANT ALL ON public.custom_agents TO service_role;
ALTER TABLE public.custom_agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages custom agents" ON public.custom_agents FOR ALL TO authenticated
  USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY "admins read custom agents" ON public.custom_agents FOR SELECT TO authenticated
  USING (public.is_admin_or_super(auth.uid()));
CREATE TRIGGER trg_custom_agents_touch BEFORE UPDATE ON public.custom_agents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.custom_agents(id) ON DELETE CASCADE,
  source_ip TEXT,
  payload JSONB,
  status TEXT NOT NULL,
  run_id UUID,
  output TEXT,
  error TEXT,
  latency_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.webhook_events TO authenticated;
GRANT ALL ON public.webhook_events TO service_role;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads webhook events" ON public.webhook_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.custom_agents a
    WHERE a.id = webhook_events.agent_id AND (a.owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  ));
CREATE INDEX idx_webhook_events_agent ON public.webhook_events(agent_id, created_at DESC);
