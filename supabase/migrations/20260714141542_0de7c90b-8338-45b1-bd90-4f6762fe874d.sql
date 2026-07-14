CREATE OR REPLACE FUNCTION public.pgrst_reload()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_notify('pgrst', 'reload schema');
$$;

GRANT EXECUTE ON FUNCTION public.pgrst_reload() TO service_role;