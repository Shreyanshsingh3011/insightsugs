
-- =========================================================================
-- 1. Notebook token hardening (fixes critical WEAK_TOKEN_AUTH_POLICY)
-- =========================================================================

-- Remove direct table access; force everything through SECURITY DEFINER RPCs.
REVOKE ALL ON public.notebook_sources FROM anon, authenticated;
REVOKE ALL ON public.notebook_messages FROM anon, authenticated;

-- Drop the weak length-only policies.
DROP POLICY IF EXISTS "notebook_sources anon by token" ON public.notebook_sources;
DROP POLICY IF EXISTS "notebook_sources authenticated by token" ON public.notebook_sources;
DROP POLICY IF EXISTS "notebook_messages anon by token" ON public.notebook_messages;
DROP POLICY IF EXISTS "notebook_messages authenticated by token" ON public.notebook_messages;

-- With no policies, RLS default-denies. service_role bypasses RLS, and the
-- new RPCs below (SECURITY DEFINER) also bypass it. Nothing else can touch
-- the tables through PostgREST.

-- Shared token guard: must be a long, high-entropy capability string.
CREATE OR REPLACE FUNCTION public.notebook_token_ok(_token text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT _token IS NOT NULL
     AND length(_token) >= 32
     AND _token ~ '^[A-Za-z0-9_\-]+$'
$$;

-- Load messages for a token (paginated / bounded).
CREATE OR REPLACE FUNCTION public.notebook_load_messages(_token text)
RETURNS TABLE (
  id uuid, role text, content text, citations jsonb,
  generated_by text, created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.notebook_token_ok(_token) THEN
    RAISE EXCEPTION 'invalid notebook token' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT m.id, m.role, m.content, m.citations, m.generated_by, m.created_at
      FROM public.notebook_messages m
     WHERE m.token = _token
     ORDER BY m.created_at ASC
     LIMIT 200;
END;
$$;

-- Load sources for a token.
CREATE OR REPLACE FUNCTION public.notebook_load_sources(_token text)
RETURNS TABLE (
  id uuid, type text, label text, enabled boolean,
  summary text, summary_generated_at timestamptz, row_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.notebook_token_ok(_token) THEN
    RAISE EXCEPTION 'invalid notebook token' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT s.id, s.type, s.label, s.enabled, s.summary,
           s.summary_generated_at, s.row_count
      FROM public.notebook_sources s
     WHERE s.token = _token;
END;
$$;

-- Upsert a source row.
CREATE OR REPLACE FUNCTION public.notebook_upsert_source(
  _token text, _type text, _label text,
  _enabled boolean DEFAULT true, _row_count int DEFAULT 0
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.notebook_token_ok(_token) THEN
    RAISE EXCEPTION 'invalid notebook token' USING ERRCODE = '22023';
  END IF;
  IF _type NOT IN ('sheet','concerns','reminders') THEN
    RAISE EXCEPTION 'invalid source type' USING ERRCODE = '22023';
  END IF;
  IF _label IS NULL OR length(_label) > 200 THEN
    RAISE EXCEPTION 'invalid label' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.notebook_sources(token, type, label, enabled, row_count)
  VALUES (_token, _type, _label, COALESCE(_enabled, true), COALESCE(_row_count, 0))
  ON CONFLICT (token, type, label)
    DO UPDATE SET enabled   = EXCLUDED.enabled,
                  row_count = EXCLUDED.row_count,
                  updated_at = now();
END;
$$;

-- Ownership check is by capability token; anyone with a valid long token
-- can call, matching the app's capability-URL model. Direct table access
-- (which allowed enumeration) is gone.
GRANT EXECUTE ON FUNCTION public.notebook_load_messages(text)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notebook_load_sources(text)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notebook_upsert_source(text, text, text, boolean, int)
  TO anon, authenticated;

-- =========================================================================
-- 2. email_group_members: scope admin access to the owning group
-- =========================================================================
DROP POLICY IF EXISTS "Admins manage email group members" ON public.email_group_members;

CREATE POLICY "Manage members of owned email groups"
ON public.email_group_members
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.email_groups g
     WHERE g.id = email_group_members.group_id
       AND g.owner_id = auth.uid()
       AND public.is_admin_or_super(auth.uid())
  )
)
WITH CHECK (
  public.has_role(auth.uid(), 'super_admin')
  OR EXISTS (
    SELECT 1 FROM public.email_groups g
     WHERE g.id = email_group_members.group_id
       AND g.owner_id = auth.uid()
       AND public.is_admin_or_super(auth.uid())
  )
);
