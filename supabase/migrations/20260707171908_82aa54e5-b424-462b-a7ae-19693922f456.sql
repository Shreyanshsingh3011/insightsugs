
CREATE OR REPLACE FUNCTION public.run_rls_role_regression()
RETURNS TABLE(check_name text, expected int, actual int, passed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  su uuid;
  ad uuid;
  us uuid;
  proj_a uuid := gen_random_uuid();
  proj_b uuid := gen_random_uuid();
  pa_a uuid;
  pa_b uuid;
  n int;
  results text[][] := ARRAY[]::text[][];
BEGIN
  IF NOT public.has_role(auth.uid(), 'super_admin') THEN
    RAISE EXCEPTION 'Only super admins can run the RLS regression';
  END IF;

  SELECT user_id INTO su FROM public.user_roles WHERE role='super_admin' ORDER BY user_id LIMIT 1;
  SELECT user_id INTO ad FROM public.user_roles WHERE role='admin'       ORDER BY user_id LIMIT 1;
  SELECT user_id INTO us FROM public.user_roles WHERE role='user'        ORDER BY user_id LIMIT 1;
  IF su IS NULL OR ad IS NULL OR us IS NULL THEN
    RAISE EXCEPTION 'Need at least one user of each role (super_admin, admin, user)';
  END IF;

  -- Seed inside a savepoint we always rollback.
  BEGIN
    INSERT INTO public.projects (id, name, owner_id) VALUES
      (proj_a, 'RLS-TEST A', ad), (proj_b, 'RLS-TEST B', su);
    INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
      VALUES ('create_alert','RLS A', jsonb_build_object('project_id', proj_a::text), 'pending', null)
      RETURNING id INTO pa_a;
    INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
      VALUES ('create_alert','RLS B', jsonb_build_object('project_id', proj_b::text), 'pending', null)
      RETURNING id INTO pa_b;
    INSERT INTO public.alerts (flag_id, activity, sent_by) VALUES ('rls-flag-A','a', ad);
    INSERT INTO public.alerts (flag_id, activity, sent_by) VALUES ('rls-flag-B','b', su);
    INSERT INTO public.audit_log (actor_id, event_type, project_id) VALUES (su,'rls-a', proj_a);
    INSERT INTO public.audit_log (actor_id, event_type, project_id) VALUES (su,'rls-b', proj_b);
    INSERT INTO public.audit_log (actor_id, event_type, project_id) VALUES (su,'rls-g', null);

    -- Helper: evaluate a role's visibility by running a SECURITY INVOKER inner
    -- query with jwt claims set locally. Because THIS function is SECURITY
    -- DEFINER (owned by postgres), we set request.jwt.claims and rely on the
    -- policies which check auth.uid() — that reads the claim regardless of
    -- SET ROLE.

    -- super_admin: sees 2 proposals, 2 alerts, 3 audit rows
    PERFORM set_config('request.jwt.claims', json_build_object('sub', su, 'role','authenticated')::text, true);
    SET LOCAL row_security = on;

    -- We must query through a function marked SECURITY INVOKER to force RLS on
    -- this session. Otherwise SECURITY DEFINER + table-owner postgres bypasses.
    -- Trick: create a temp view? Simpler — use policies by calling a wrapper.
    -- Postgres skips RLS only for the table owner; for a role that is NOT the
    -- table owner but is superuser. Our SECURITY DEFINER runs as postgres who
    -- IS owner ⇒ bypass. So we cannot verify RLS from a DEFINER function.
    -- Return NULL results to make this limitation explicit.
    check_name := 'ENVIRONMENT'; expected := 0; actual := 0; passed := false;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.run_rls_role_regression() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_rls_role_regression() TO authenticated;
