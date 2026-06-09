
UPDATE auth.users SET email_confirmed_at = now()
WHERE email IN ('superadmin@test.com','admin@test.com') AND email_confirmed_at IS NULL;

DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email IN ('superadmin@test.com','admin@test.com'));

INSERT INTO public.user_roles(user_id, role)
SELECT id, 'super_admin'::app_role FROM auth.users WHERE email = 'superadmin@test.com';

INSERT INTO public.user_roles(user_id, role)
SELECT id, 'admin'::app_role FROM auth.users WHERE email = 'admin@test.com';

INSERT INTO public.profiles(id, full_name, email)
SELECT id, COALESCE(raw_user_meta_data->>'full_name',''), email FROM auth.users
WHERE email IN ('superadmin@test.com','admin@test.com')
ON CONFLICT (id) DO NOTHING;
