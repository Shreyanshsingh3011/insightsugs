GRANT EXECUTE ON FUNCTION public.is_admin_or_super(uuid) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.match_doc_chunks(uuid, vector, uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_default_doc_folders(uuid) TO authenticated, service_role;