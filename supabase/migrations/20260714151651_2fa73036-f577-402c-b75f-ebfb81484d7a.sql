
CREATE OR REPLACE FUNCTION public.increment_agent_run_count(_agent_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.custom_agents
     SET run_count   = COALESCE(run_count, 0) + 1,
         last_run_at = now()
   WHERE id = _agent_id;
$$;

REVOKE ALL ON FUNCTION public.increment_agent_run_count(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_agent_run_count(uuid) TO service_role;
