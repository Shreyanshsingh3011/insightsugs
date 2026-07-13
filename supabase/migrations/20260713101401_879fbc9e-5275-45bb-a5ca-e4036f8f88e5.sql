
CREATE OR REPLACE FUNCTION public.grant_super_admin_for_designated_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL
     AND lower(NEW.email) IN ('yash@sugslloyds.com', 'shreyansh.singh3011@gmail.com') THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_grant_super ON auth.users;
CREATE TRIGGER on_auth_user_created_grant_super
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.grant_super_admin_for_designated_emails();

DROP TRIGGER IF EXISTS on_auth_user_confirmed_grant_super ON auth.users;
CREATE TRIGGER on_auth_user_confirmed_grant_super
AFTER UPDATE OF email_confirmed_at ON auth.users
FOR EACH ROW
WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
EXECUTE FUNCTION public.grant_super_admin_for_designated_emails();

-- Backfill: grant now if the user already exists and is verified
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'super_admin'::app_role
FROM auth.users
WHERE lower(email) IN ('yash@sugslloyds.com', 'shreyansh.singh3011@gmail.com')
  AND email_confirmed_at IS NOT NULL
ON CONFLICT (user_id, role) DO NOTHING;
