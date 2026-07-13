-- Restore GRANTs that were lost. Safe to re-run.

-- user_roles: auth-only reads via has_role(); no anon
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

-- profiles
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='profiles') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated';
    EXECUTE 'GRANT ALL ON public.profiles TO service_role';
  END IF;
END $$;

-- allowlist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='allowlist') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.allowlist TO authenticated';
    EXECUTE 'GRANT ALL ON public.allowlist TO service_role';
  END IF;
END $$;

-- pending_signups
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='pending_signups') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_signups TO authenticated';
    EXECUTE 'GRANT ALL ON public.pending_signups TO service_role';
  END IF;
END $$;

-- Ensure bootstrap super_admins exist in user_roles
DO $$
DECLARE
  uid uuid;
BEGIN
  FOR uid IN
    SELECT id FROM auth.users
    WHERE lower(email) IN ('shreyansh.singh3011@gmail.com', 'yash@sugslloyds.com')
  LOOP
    INSERT INTO public.user_roles (user_id, role)
    VALUES (uid, 'super_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END LOOP;
END $$;