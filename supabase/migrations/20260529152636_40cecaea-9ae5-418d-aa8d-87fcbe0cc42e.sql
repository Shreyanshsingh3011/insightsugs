
revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
revoke execute on function public.is_admin_or_super(uuid) from public, anon;
revoke execute on function public.can_see_project(uuid, uuid) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
