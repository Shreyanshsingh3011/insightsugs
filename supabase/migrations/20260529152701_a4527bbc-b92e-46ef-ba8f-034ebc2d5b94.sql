
revoke execute on function public.has_role(uuid, public.app_role) from authenticated;
revoke execute on function public.is_admin_or_super(uuid) from authenticated;
revoke execute on function public.can_see_project(uuid, uuid) from authenticated;

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
