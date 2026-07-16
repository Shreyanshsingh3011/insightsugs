CREATE OR REPLACE FUNCTION public.try_run_lock(_key bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT pg_try_advisory_lock(_key); $$;

CREATE OR REPLACE FUNCTION public.release_run_lock(_key bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$ SELECT pg_advisory_unlock(_key); $$;

REVOKE ALL ON FUNCTION public.try_run_lock(bigint) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_run_lock(bigint) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_run_lock(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_run_lock(bigint) TO service_role;