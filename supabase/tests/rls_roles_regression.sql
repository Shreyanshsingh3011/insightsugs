-- Role-scoped RLS regression test.
--
-- Run with:  psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_roles_regression.sql
--
-- What it does:
--   1. Seeds three throwaway auth users (super_admin, admin_a, user_a) plus
--      two projects (project_a owned by admin_a, project_b owned by nobody
--      in this test) and one pending_action, one alert, one concern per
--      project scope.
--   2. Impersonates each role via `SET LOCAL request.jwt.claims` and asserts
--      row visibility with `ASSERT` blocks.
--   3. Rolls back everything so the database is untouched.
--
-- Fails loudly on any regression; exit code != 0.

BEGIN;

-- --- seed helpers ------------------------------------------------------------

DO $$
DECLARE
  su   uuid := gen_random_uuid();
  ad   uuid := gen_random_uuid();
  us   uuid := gen_random_uuid();
  proj_a uuid := gen_random_uuid();
  proj_b uuid := gen_random_uuid();
  pa_a uuid;
  pa_b uuid;
  al_a uuid;
  co_a uuid;
  n_visible int;
BEGIN
  -- Minimal auth.users rows (service role only, this test runs as postgres).
  INSERT INTO auth.users (id, email, aud, role, instance_id)
  VALUES
    (su, 'rls-super@test.local', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (ad, 'rls-admin@test.local', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
    (us, 'rls-user@test.local',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

  INSERT INTO public.profiles (id, email, full_name, department)
  VALUES
    (su, 'rls-super@test.local', 'Super', 'ops'),
    (ad, 'rls-admin@test.local', 'Admin', 'ops'),
    (us, 'rls-user@test.local',  'User',  'ops');

  INSERT INTO public.user_roles (user_id, role) VALUES
    (su, 'super_admin'), (ad, 'admin'), (us, 'user');

  INSERT INTO public.projects (id, name, owner_id) VALUES
    (proj_a, 'Project A (admin owned)', ad),
    (proj_b, 'Project B (foreign)',     su);

  -- pending_actions: one tied to project_a, one tied to project_b, one w/o payload project.
  INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
  VALUES ('create_alert', 'A-scoped', jsonb_build_object('project_id', proj_a::text), 'pending', null)
  RETURNING id INTO pa_a;

  INSERT INTO public.pending_actions (kind, summary, payload, status, proposed_by)
  VALUES ('create_alert', 'B-scoped', jsonb_build_object('project_id', proj_b::text), 'pending', null)
  RETURNING id INTO pa_b;

  -- Alerts: one sent by admin, one sent by super.
  INSERT INTO public.alerts (flag_id, activity, sent_by)
    VALUES ('rls-flag-1', 'act1', ad);
  INSERT INTO public.alerts (flag_id, activity, sent_by)
    VALUES ('rls-flag-2', 'act2', su);

  -- Concerns: one raised by user (target dept = ops), one raised by super to a foreign dept.
  INSERT INTO public.concerns (raised_by, target_dept, title, body)
    VALUES (us, 'ops', 'ops concern', '');
  INSERT INTO public.concerns (raised_by, target_dept, title, body)
    VALUES (su, 'finance', 'finance concern', '');

  RAISE NOTICE 'Seed done: super=% admin=% user=% proj_a=% proj_b=%', su, ad, us, proj_a, proj_b;

  -- --- helper to impersonate --------------------------------------------------
  -- The RLS policies read auth.uid(), which pulls from request.jwt.claims.sub.

  --------------------- SUPER ADMIN --------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', su, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);

  SELECT count(*) INTO n_visible FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n_visible = 2, format('super_admin should see both proposals, got %s', n_visible);

  SELECT count(*) INTO n_visible FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n_visible = 2, format('super_admin should see both alerts, got %s', n_visible);

  SELECT count(*) INTO n_visible FROM public.concerns WHERE title IN ('ops concern','finance concern');
  ASSERT n_visible = 2, format('super_admin should see both concerns, got %s', n_visible);

  --------------------- ADMIN (project A owner) --------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO n_visible FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n_visible = 1, format('admin should see only project_a proposal, got %s', n_visible);
  PERFORM 1 FROM public.pending_actions WHERE id = pa_a;
  ASSERT FOUND, 'admin must see project_a proposal';
  PERFORM 1 FROM public.pending_actions WHERE id = pa_b;
  ASSERT NOT FOUND, 'admin must NOT see project_b proposal';

  SELECT count(*) INTO n_visible FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n_visible = 1, format('admin should see only alerts they sent, got %s', n_visible);

  SELECT count(*) INTO n_visible FROM public.concerns WHERE title IN ('ops concern','finance concern');
  ASSERT n_visible = 1, format('admin (ops dept) should see 1 concern, got %s', n_visible);

  --------------------- USER ---------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);

  SELECT count(*) INTO n_visible FROM public.pending_actions WHERE id IN (pa_a, pa_b);
  ASSERT n_visible = 0, format('plain user with no project link should see 0 proposals, got %s', n_visible);

  SELECT count(*) INTO n_visible FROM public.alerts WHERE flag_id LIKE 'rls-flag-%';
  ASSERT n_visible = 0, format('plain user should see 0 alerts, got %s', n_visible);

  SELECT count(*) INTO n_visible FROM public.concerns WHERE title IN ('ops concern','finance concern');
  ASSERT n_visible = 1, format('user (ops dept, raised ops) should see 1 concern, got %s', n_visible);

  --------------------- AUDIT LOG ----------------------------
  -- Insert an audit row scoped to project_a, one with null project (global).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', su, 'role', 'authenticated')::text, true);
  INSERT INTO public.audit_log (actor_id, action, project_id) VALUES (su, 'test-a', proj_a);
  INSERT INTO public.audit_log (actor_id, action, project_id) VALUES (su, 'test-global', null);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', ad, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n_visible FROM public.audit_log WHERE action IN ('test-a','test-global');
  ASSERT n_visible = 2, format('admin (owns proj_a) should see project-a + global audit, got %s', n_visible);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO n_visible FROM public.audit_log WHERE action IN ('test-a','test-global');
  ASSERT n_visible = 0, format('plain user should see 0 audit rows (not admin), got %s', n_visible);

  RAISE NOTICE '✅ All role-scoped RLS assertions passed.';
END $$;

ROLLBACK;
