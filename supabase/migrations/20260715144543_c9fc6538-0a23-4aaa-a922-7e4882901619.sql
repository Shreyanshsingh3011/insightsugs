
-- 1) Uniqueness for sheet_rows enables ON CONFLICT upsert during sync
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sheet_rows_registry_row_unique'
  ) THEN
    ALTER TABLE public.sheet_rows
      ADD CONSTRAINT sheet_rows_registry_row_unique
      UNIQUE (sheet_registry_id, row_index);
  END IF;
END$$;

-- 2) Revoke anon EXECUTE on app-level SECURITY DEFINER functions.
-- These all check auth.uid() internally, but revoking anon is defense-in-depth.
REVOKE EXECUTE ON FUNCTION public.approve_signup(uuid, app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reject_signup(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resend_signup_verification(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.self_verify_signup(app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.verify_signup_from_allowlist() FROM anon;
REVOKE EXECUTE ON FUNCTION public.set_my_project_assignments(text[], text[]) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_doc_folder(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.seed_default_doc_folders(uuid) FROM anon;

-- 3) Revoke anon AND authenticated EXECUTE on internal/queue/cron helpers.
-- These are only called by pg_cron/service_role, never by end users.
REVOKE EXECUTE ON FUNCTION public.pgrst_reload() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.enqueue_email(text, jsonb) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(text, integer, integer) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.delete_email(text, bigint) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(text, text, bigint, jsonb) FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.increment_agent_run_count(uuid) FROM anon;
