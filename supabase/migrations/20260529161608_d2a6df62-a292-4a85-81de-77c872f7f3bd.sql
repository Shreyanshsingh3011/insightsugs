CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  requested text;
  assigned app_role;
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), coalesce(new.email,''))
  on conflict (id) do nothing;

  requested := new.raw_user_meta_data->>'requested_role';

  if not exists (select 1 from public.user_roles where role = 'super_admin') then
    assigned := 'super_admin';
  elsif requested in ('super_admin','admin','user') then
    assigned := requested::app_role;
  else
    assigned := 'user';
  end if;

  insert into public.user_roles(user_id, role) values (new.id, assigned) on conflict do nothing;
  return new;
end;
$function$;