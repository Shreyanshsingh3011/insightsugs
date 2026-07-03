
CREATE TABLE IF NOT EXISTS public.signup_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  requested_role public.app_role NOT NULL DEFAULT 'user',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  verified_via text CHECK (verified_via IN ('sheet','admin','bootstrap')),
  granted_role public.app_role,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.signup_requests TO authenticated;
GRANT ALL ON public.signup_requests TO service_role;

ALTER TABLE public.signup_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sr_read_own ON public.signup_requests;
CREATE POLICY sr_read_own ON public.signup_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

-- Replace handle_new_user: create pending request; only bootstrap first super_admin.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  requested text;
  req_role app_role;
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), coalesce(new.email,''))
  on conflict (id) do nothing;

  requested := new.raw_user_meta_data->>'requested_role';
  req_role := case when requested in ('super_admin','admin','user') then requested::app_role else 'user'::app_role end;

  -- Bootstrap: first ever user becomes super_admin (auto-approved).
  if not exists (select 1 from public.user_roles where role = 'super_admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'super_admin') on conflict do nothing;
    insert into public.signup_requests (user_id, email, full_name, requested_role, status, verified_via, granted_role, reviewed_at)
    values (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',''), 'super_admin', 'approved', 'bootstrap', 'super_admin', now())
    on conflict (user_id) do nothing;
  else
    insert into public.signup_requests (user_id, email, full_name, requested_role)
    values (new.id, coalesce(new.email,''), coalesce(new.raw_user_meta_data->>'full_name',''), req_role)
    on conflict (user_id) do nothing;
  end if;

  return new;
end;
$function$;

-- Super admin approve / reject
CREATE OR REPLACE FUNCTION public.approve_signup(_request_id uuid, _role public.app_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  target uuid;
begin
  if not public.has_role(auth.uid(), 'super_admin') then
    raise exception 'Only super admins can approve signups';
  end if;
  select user_id into target from public.signup_requests where id = _request_id;
  if target is null then raise exception 'Request not found'; end if;

  delete from public.user_roles where user_id = target;
  insert into public.user_roles(user_id, role) values (target, _role) on conflict do nothing;

  update public.signup_requests
    set status = 'approved', verified_via = 'admin', granted_role = _role,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = _request_id;
end $$;

CREATE OR REPLACE FUNCTION public.reject_signup(_request_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
begin
  if not public.has_role(auth.uid(), 'super_admin') then
    raise exception 'Only super admins can reject signups';
  end if;
  update public.signup_requests
    set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), reject_reason = _reason
    where id = _request_id;
end $$;

-- Self-verify via allowlist sheet (called from a server fn that has verified the sheet match).
-- This RPC only trusts the CALLER's own row and only ever grants 'user' or 'admin' from the sheet.
CREATE OR REPLACE FUNCTION public.self_verify_signup(_role public.app_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  uid uuid := auth.uid();
  req_id uuid;
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if _role not in ('user','admin') then
    raise exception 'Sheet allowlist may only grant user or admin';
  end if;
  select id into req_id from public.signup_requests where user_id = uid and status = 'pending';
  if req_id is null then return; end if;

  insert into public.user_roles(user_id, role) values (uid, _role) on conflict do nothing;
  update public.signup_requests
    set status = 'approved', verified_via = 'sheet', granted_role = _role, reviewed_at = now()
    where id = req_id;
end $$;

REVOKE EXECUTE ON FUNCTION public.approve_signup(uuid, public.app_role) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.reject_signup(uuid, text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.self_verify_signup(public.app_role) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.approve_signup(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_signup(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.self_verify_signup(public.app_role) TO authenticated;

-- Backfill: any existing users without a role and without a request get a pending one.
INSERT INTO public.signup_requests (user_id, email, full_name, requested_role)
SELECT u.id, coalesce(u.email,''), coalesce(u.raw_user_meta_data->>'full_name',''),
  coalesce((u.raw_user_meta_data->>'requested_role')::public.app_role, 'user')
FROM auth.users u
LEFT JOIN public.user_roles r ON r.user_id = u.id
LEFT JOIN public.signup_requests s ON s.user_id = u.id
WHERE r.user_id IS NULL AND s.user_id IS NULL;
