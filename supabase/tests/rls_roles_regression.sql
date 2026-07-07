-- Role-scoped RLS regression test.
--
-- Run:  psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_roles_regression.sql
--
-- Uses the FIRST existing user of each role (super_admin, admin, user) to
-- avoid needing auth-schema write privileges. Everything is inserted inside
-- a transaction and ROLLED BACK — the database is unchanged.
--
-- Asserts that:
--   * super_admin sees every proposal / alert / concern / audit row we seed
--   * admin sees only rows tied to a project they own (via can_see_project)
--     or that they authored themselves
--   * plain user sees only rows they raised / are assigned / target their dept
--
-- Fails loudly on any regression (nonzero exit).

BEGIN;

DO $$
DECLARE
  su   uuid;
  ad   uuid;
  us   uuid;
  proj_a uuid := gen_random_uuid();
  proj_b uuid := gen_random_uuid();
  pa_a uuid;
  pa_b uuid;
  n int;
  admin_dept text;
BEGIN
  SELECT user_id INTO su FROM public.user_roles WHERE role = 'super_admin' ORDER BY user_id LIMIT 1;
  SELECT user_id INTO ad FROM public.user_roles WHERE role = 'admin'       ORDER BY user_id LIMIT 1;
  SELECT user_id INTO us FROM public.user_roles WHERE role = 'user'        ORDER BY user_id LIMIT 1;

  IF su IS NULL OR ad IS NULL OR us IS NULL THEN
    RAISE EXCEPTION 'Need at least one user per role. Have super=% admin=% user=%', su, ad, us;
  END IF;

  SELECT department INTO admin_dept FROM public.profiles WHERE id = ad;

  RAISE NOTICE 'Using super=% admin=% (dept=%) user=%', su, ad, coalesce(admin_dept,'∅'), us;

  -- Seed projects: A owned by admin, B owned by super.
  INSERT INTO public.projects (id, name, owner_id) VALUES
    (proj_a, 'RLS-TEST project A', ad),
    (proj_b, 'RLS-TEST project B', su);

  -- Seed proposals tied to each project.
  INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
    VALUES ('create_alert', 'RLS A', jsonb_build_object('project_id', proj_a::text), 'pending', null)
    RETURNING id INTO pa_a;
  INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
    VALUES ('create_alert', 'RLS B', jsonb_build_object('project_id', proj_b::text), 'pending', null)
    RETURNING id INTO pa_b;

  -- Seed alerts: one sent by admin, one sent by super.
  INSERT INTO public.alerts (flag_id, activity, sent_by) VALUES ('rls-flag-A', 'a', ad);
  INSERT INTO public.alerts (flag_id, activity, sent_by) VALUES ('rls-flag-B', 'b', su);

  -- Audit rows.
  INSERT INTO public.audit_log (actor_id, action, project_id) VALUES (su, 'rls-a', proj_a);
  INSERT INTO public.audit_log (actor_id, action, project_id) VALUES (su, 'rls-b', proj_b);
  INSERT INTO public.audit_log (actor_id, action, project_id) VALUES (su, 'rls-g', null);

  PERFORM set_config('role', 'authenticated', true);

  ------------------ SUPER_ADMIN sees everything ------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', su, 'role','authenticated')::text, true);

  SELECT count(*) INTO n FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n = 2, format('super sees both proposals — got %s', n);

  SELECT count(*) INTO n FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n = 2, format('super sees both alerts — got %s', n);

  SELECT count(*) INTO n FROM public.audit_log WHERE action LIKE 'rls-%';
  ASSERT n = 3, format('super sees all audit rows — got %s', n);

  ------------------ ADMIN scoped to project A --------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ad, 'role','authenticated')::text, true);

  SELECT count(*) INTO n FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n = 1, format('admin sees only their project proposal — got %s', n);
  PERFORM 1 FROM public.pending_actions WHERE id = pa_a; ASSERT FOUND,     'admin should see project_a proposal';
  PERFORM 1 FROM public.pending_actions WHERE id = pa_b; ASSERT NOT FOUND, 'admin must NOT see project_b proposal';

  SELECT count(*) INTO n FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n = 1, format('admin sees only alerts they sent — got %s', n);

  -- Audit: admin owns proj_a → sees rls-a + rls-g (null project); NOT rls-b.
  SELECT count(*) INTO n FROM public.audit_log WHERE action LIKE 'rls-%';
  ASSERT n = 2, format('admin sees own-project + null-project audit — got %s', n);
  PERFORM 1 FROM public.audit_log WHERE action = 'rls-b'; ASSERT NOT FOUND, 'admin must NOT see foreign-project audit';

  ------------------ PLAIN USER sees nothing project-linked -------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', us, 'role','authenticated')::text, true);

  SELECT count(*) INTO n FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n = 0, format('user with no project link sees 0 proposals — got %s', n);

  SELECT count(*) INTO n FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n = 0, format('user sees 0 alerts (not sent, not recipient) — got %s', n);

  SELECT count(*) INTO n FROM public.audit_log WHERE action LIKE 'rls-%';
  ASSERT n = 0, format('user sees 0 audit rows (not admin) — got %s', n);

  RAISE NOTICE '✅ All role-scoped RLS assertions passed.';
END $$;

ROLLBACK;
