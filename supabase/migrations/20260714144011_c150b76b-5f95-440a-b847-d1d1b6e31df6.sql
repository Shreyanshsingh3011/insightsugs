
CREATE TABLE IF NOT EXISTS public.bootstrap_admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  user_id uuid UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT bootstrap_admins_target_check CHECK (email IS NOT NULL OR user_id IS NOT NULL)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bootstrap_admins TO authenticated;
GRANT ALL ON public.bootstrap_admins TO service_role;

ALTER TABLE public.bootstrap_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "super_admin_read_bootstrap" ON public.bootstrap_admins;
CREATE POLICY "super_admin_read_bootstrap" ON public.bootstrap_admins
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'));

DROP POLICY IF EXISTS "super_admin_write_bootstrap" ON public.bootstrap_admins;
CREATE POLICY "super_admin_write_bootstrap" ON public.bootstrap_admins
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));

INSERT INTO public.bootstrap_admins (email, note) VALUES
  ('shreyansh.singh3011@gmail.com', 'initial bootstrap'),
  ('yash@sugslloyds.com', 'initial bootstrap'),
  ('r.sharma@sugslloyds.com', 'initial bootstrap')
ON CONFLICT (email) DO NOTHING;

INSERT INTO public.bootstrap_admins (user_id, note) VALUES
  ('b530da41-caa8-4ead-b5fe-8eb3bc446ace', 'initial bootstrap uid')
ON CONFLICT (user_id) DO NOTHING;

-- Update the auth trigger to source from the table (with hardcoded fallback)
CREATE OR REPLACE FUNCTION public.grant_super_admin_for_designated_emails()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.email_confirmed_at IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.bootstrap_admins WHERE lower(email) = lower(NEW.email))
    OR EXISTS (SELECT 1 FROM public.bootstrap_admins WHERE user_id = NEW.id)
    OR lower(NEW.email) IN ('yash@sugslloyds.com', 'shreyansh.singh3011@gmail.com', 'r.sharma@sugslloyds.com')
  ) THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'super_admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- RPC for the client-side helper to fetch the current effective bootstrap list
CREATE OR REPLACE FUNCTION public.list_bootstrap_admins()
RETURNS TABLE(email text, user_id uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(email), user_id FROM public.bootstrap_admins;
$$;

GRANT EXECUTE ON FUNCTION public.list_bootstrap_admins() TO authenticated, anon, service_role;
