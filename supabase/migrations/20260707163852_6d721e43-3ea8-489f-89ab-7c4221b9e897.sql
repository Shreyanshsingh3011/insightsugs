
-- 1) Allowlist table
CREATE TABLE IF NOT EXISTS public.signup_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text,
  role public.app_role NOT NULL DEFAULT 'user',
  note text,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS signup_allowlist_email_key
  ON public.signup_allowlist (lower(btrim(email)));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signup_allowlist TO authenticated;
GRANT ALL ON public.signup_allowlist TO service_role;

ALTER TABLE public.signup_allowlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allowlist super admins manage" ON public.signup_allowlist;
CREATE POLICY "allowlist super admins manage"
  ON public.signup_allowlist FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

CREATE OR REPLACE TRIGGER signup_allowlist_touch_updated_at
  BEFORE UPDATE ON public.signup_allowlist
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 2) Self-verify against the in-app allowlist.
-- SECURITY DEFINER so authenticated users can check themselves without
-- needing SELECT on signup_allowlist. Only ever grants role to auth.uid().
CREATE OR REPLACE FUNCTION public.verify_signup_from_allowlist()
RETURNS TABLE(verified boolean, reason text, granted_role public.app_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  my_email text;
  my_name  text;
  hit record;
  req_id uuid;
BEGIN
  IF uid IS NULL THEN
    RETURN QUERY SELECT false, 'Not authenticated'::text, NULL::app_role;
    RETURN;
  END IF;

  -- Already approved?
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = uid) THEN
    RETURN QUERY SELECT true, 'already approved'::text, NULL::app_role;
    RETURN;
  END IF;

  SELECT lower(btrim(coalesce(email,''))), lower(btrim(coalesce(full_name,'')))
    INTO my_email, my_name
    FROM public.profiles WHERE id = uid;

  IF coalesce(my_email,'') = '' THEN
    RETURN QUERY SELECT false, 'No email on profile'::text, NULL::app_role;
    RETURN;
  END IF;

  SELECT a.role,
         lower(btrim(coalesce(a.full_name,''))) AS name_norm
    INTO hit
    FROM public.signup_allowlist a
    WHERE lower(btrim(a.email)) = my_email
    LIMIT 1;

  IF hit IS NULL THEN
    RETURN QUERY SELECT false,
      'Not found in allowlist - awaiting super admin approval.'::text,
      NULL::app_role;
    RETURN;
  END IF;

  -- Optional name check: if both sides have a name, require a match.
  IF hit.name_norm <> '' AND my_name <> '' AND hit.name_norm <> my_name THEN
    RETURN QUERY SELECT false,
      'Email in allowlist but name does not match.'::text,
      NULL::app_role;
    RETURN;
  END IF;

  -- Only user or admin auto-granted; super_admin must be explicit.
  IF hit.role NOT IN ('user','admin') THEN
    RETURN QUERY SELECT false,
      'Allowlist role requires super admin review.'::text,
      NULL::app_role;
    RETURN;
  END IF;

  INSERT INTO public.user_roles(user_id, role)
    VALUES (uid, hit.role) ON CONFLICT DO NOTHING;

  SELECT id INTO req_id FROM public.signup_requests
    WHERE user_id = uid AND status = 'pending' LIMIT 1;
  IF req_id IS NOT NULL THEN
    UPDATE public.signup_requests
      SET status = 'approved',
          verified_via = 'allowlist',
          granted_role = hit.role,
          reviewed_at = now()
      WHERE id = req_id;
  END IF;

  RETURN QUERY SELECT true, 'Matched in allowlist'::text, hit.role;
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_signup_from_allowlist() TO authenticated;

-- 3) Notify all super admins when a new pending signup arrives.
CREATE OR REPLACE FUNCTION public.tg_signup_notify_super_admins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, kind, title, body)
  SELECT ur.user_id,
         'signup_pending_review',
         'New signup awaiting review',
         coalesce(NEW.full_name, '(no name)') || ' <' || NEW.email || '> requested ' || NEW.requested_role::text || ' access.'
    FROM public.user_roles ur
    WHERE ur.role = 'super_admin';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signup_requests_notify_super_admins ON public.signup_requests;
CREATE TRIGGER signup_requests_notify_super_admins
  AFTER INSERT ON public.signup_requests
  FOR EACH ROW EXECUTE FUNCTION public.tg_signup_notify_super_admins();

-- 4) Helper: list super admin emails (for the email fan-out server fn).
CREATE OR REPLACE FUNCTION public.list_super_admin_emails()
RETURNS TABLE(user_id uuid, email text, full_name text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.email, p.full_name
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.role = 'super_admin'
      AND coalesce(p.email, '') <> '';
$$;
GRANT EXECUTE ON FUNCTION public.list_super_admin_emails() TO authenticated;
