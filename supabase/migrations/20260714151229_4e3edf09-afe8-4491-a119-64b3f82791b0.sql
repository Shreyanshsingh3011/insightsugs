
-- =========================================================================
-- C1: One-time super_admin bootstrap
-- =========================================================================
-- Previously handle_new_user() checked "any super_admin exists?" every signup.
-- If all super admins were later offboarded, the *next* public signup would be
-- auto-promoted. Replace that check with a persistent flag row that is set
-- exactly once and never re-opens, plus an advisory lock to serialize the
-- decision under concurrent signups.

CREATE TABLE IF NOT EXISTS public.system_bootstrap_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  super_admin_bootstrapped boolean NOT NULL DEFAULT false,
  bootstrapped_user_id uuid,
  bootstrapped_at timestamptz
);

GRANT SELECT ON public.system_bootstrap_state TO authenticated;
GRANT ALL ON public.system_bootstrap_state TO service_role;

ALTER TABLE public.system_bootstrap_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bootstrap_state_admin_read ON public.system_bootstrap_state;
CREATE POLICY bootstrap_state_admin_read ON public.system_bootstrap_state
  FOR SELECT TO authenticated
  USING (public.is_admin_or_super(auth.uid()));

-- Seed exactly one row.
INSERT INTO public.system_bootstrap_state (id, super_admin_bootstrapped, bootstrapped_user_id, bootstrapped_at)
VALUES (true, false, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- If a super_admin already exists, mark bootstrap complete so the trigger
-- never fires again for future signups.
UPDATE public.system_bootstrap_state s
   SET super_admin_bootstrapped = true,
       bootstrapped_at = COALESCE(s.bootstrapped_at, now())
 WHERE s.id = true
   AND EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin');

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  requested text;
  req_role app_role;
  already_bootstrapped boolean;
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), coalesce(new.email,''))
  ON CONFLICT (id) DO NOTHING;

  requested := new.raw_user_meta_data->>'requested_role';
  req_role := CASE WHEN requested IN ('super_admin','admin','user') THEN requested::app_role ELSE 'user'::app_role END;

  -- Serialize the bootstrap decision so two concurrent first-ever signups
  -- can't both be promoted.
  PERFORM pg_advisory_xact_lock(7700000000000010);

  SELECT super_admin_bootstrapped INTO already_bootstrapped
    FROM public.system_bootstrap_state WHERE id = true FOR UPDATE;

  IF NOT COALESCE(already_bootstrapped, false)
     AND NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    INSERT INTO public.user_roles(user_id, role)
    VALUES (new.id, 'super_admin') ON CONFLICT DO NOTHING;

    INSERT INTO public.signup_requests (user_id, email, full_name, requested_role, status, verified_via, granted_role, reviewed_at)
    VALUES (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',''),
            'super_admin', 'approved', 'bootstrap', 'super_admin', now())
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.system_bootstrap_state
       SET super_admin_bootstrapped = true,
           bootstrapped_user_id = new.id,
           bootstrapped_at = now()
     WHERE id = true;
  ELSE
    INSERT INTO public.signup_requests (user_id, email, full_name, requested_role)
    VALUES (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',''), req_role)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;

  RETURN new;
END;
$$;

-- =========================================================================
-- H1: Profile self-update column restrictions
-- =========================================================================
-- profiles_self_update let users rewrite their own email, manager_id, and
-- department. Replace it with a trigger that reverts any change to those
-- protected columns unless the caller is an admin/super_admin.

CREATE OR REPLACE FUNCTION public.enforce_profile_self_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Admins can edit anything. Service role bypasses RLS entirely and
  -- doesn't hit this trigger with a meaningful auth.uid(), so allow that too.
  IF auth.uid() IS NULL OR public.is_admin_or_super(auth.uid()) THEN
    RETURN NEW;
  END IF;

  -- Self-edit: preserve identity-critical columns.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Cannot change profile id';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email := OLD.email;
  END IF;
  IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
    NEW.manager_id := OLD.manager_id;
  END IF;
  IF NEW.department IS DISTINCT FROM OLD.department THEN
    NEW.department := OLD.department;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_profile_self_update_trg ON public.profiles;
CREATE TRIGGER enforce_profile_self_update_trg
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_profile_self_update();
