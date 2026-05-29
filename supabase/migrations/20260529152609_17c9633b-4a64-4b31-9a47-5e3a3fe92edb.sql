
create type public.app_role as enum ('super_admin', 'admin', 'user');
create type public.activity_status as enum ('pending', 'in_progress', 'completed', 'blocked', 'overdue');

-- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  department text,
  manager_id uuid references public.profiles(id) on delete set null,
  sheet_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

-- user_roles
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.is_admin_or_super(_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role in ('admin','super_admin'))
$$;

-- delay reasons
create table public.delay_reasons (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  label text not null,
  active boolean not null default true
);
grant select on public.delay_reasons to authenticated;
grant all on public.delay_reasons to service_role;
alter table public.delay_reasons enable row level security;
insert into public.delay_reasons (code,label) values
  ('waiting_client','Waiting on client'),
  ('govt_pending','Govt approval pending'),
  ('internal_dependency','Internal dependency'),
  ('resource_shortage','Resource shortage'),
  ('other','Other');

-- holidays
create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  label text
);
grant select on public.holidays to authenticated;
grant all on public.holidays to service_role;
alter table public.holidays enable row level security;

-- projects
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text unique,
  description text,
  owner_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.projects to authenticated;
grant all on public.projects to service_role;
alter table public.projects enable row level security;

-- project_members
create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'admin',
  primary key (project_id, user_id)
);
grant select, insert, update, delete on public.project_members to authenticated;
grant all on public.project_members to service_role;
alter table public.project_members enable row level security;

-- activities
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  description text,
  department text,
  tat_days integer,
  start_date date,
  due_date date,
  assignee_id uuid references public.profiles(id) on delete set null,
  depends_on uuid references public.activities(id) on delete set null,
  status public.activity_status not null default 'pending',
  delay_reason_id uuid references public.delay_reasons(id) on delete set null,
  delay_note text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.activities to authenticated;
grant all on public.activities to service_role;
alter table public.activities enable row level security;

-- visibility helper (after activities exists)
create or replace function public.can_see_project(_user_id uuid, _project_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select
    public.has_role(_user_id,'super_admin')
    or exists (select 1 from public.projects p where p.id = _project_id and p.owner_id = _user_id)
    or exists (select 1 from public.project_members m where m.project_id = _project_id and m.user_id = _user_id)
    or exists (select 1 from public.activities a where a.project_id = _project_id and a.assignee_id = _user_id)
$$;

-- audit_log
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  activity_id uuid references public.activities(id) on delete set null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_project_idx on public.audit_log(project_id, created_at desc);
create index audit_log_activity_idx on public.audit_log(activity_id, created_at desc);
grant select, insert on public.audit_log to authenticated;
grant all on public.audit_log to service_role;
alter table public.audit_log enable row level security;

-- ============ POLICIES ============
create policy "profiles_self_read" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles_self_update" on public.profiles for update to authenticated using (id = auth.uid());
create policy "profiles_admin_read" on public.profiles for select to authenticated using (public.is_admin_or_super(auth.uid()));

create policy "user_roles_self_read" on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy "user_roles_super_read_all" on public.user_roles for select to authenticated using (public.has_role(auth.uid(),'super_admin'));
create policy "user_roles_super_write" on public.user_roles for all to authenticated
  using (public.has_role(auth.uid(),'super_admin')) with check (public.has_role(auth.uid(),'super_admin'));

create policy "delay_reasons_read" on public.delay_reasons for select to authenticated using (true);
create policy "delay_reasons_admin_write" on public.delay_reasons for all to authenticated
  using (public.is_admin_or_super(auth.uid())) with check (public.is_admin_or_super(auth.uid()));

create policy "holidays_read" on public.holidays for select to authenticated using (true);
create policy "holidays_admin_write" on public.holidays for all to authenticated
  using (public.is_admin_or_super(auth.uid())) with check (public.is_admin_or_super(auth.uid()));

create policy "projects_visible" on public.projects for select to authenticated using (public.can_see_project(auth.uid(), id));
create policy "projects_admin_write" on public.projects for all to authenticated
  using (public.is_admin_or_super(auth.uid())) with check (public.is_admin_or_super(auth.uid()));

create policy "project_members_visible" on public.project_members for select to authenticated using (public.can_see_project(auth.uid(), project_id));
create policy "project_members_admin_write" on public.project_members for all to authenticated
  using (public.is_admin_or_super(auth.uid())) with check (public.is_admin_or_super(auth.uid()));

create policy "activities_visible" on public.activities for select to authenticated
  using (assignee_id = auth.uid() or public.can_see_project(auth.uid(), project_id));
create policy "activities_admin_write" on public.activities for all to authenticated
  using (public.is_admin_or_super(auth.uid())) with check (public.is_admin_or_super(auth.uid()));
create policy "activities_assignee_update" on public.activities for update to authenticated
  using (assignee_id = auth.uid()) with check (assignee_id = auth.uid());

create policy "audit_log_admin_read" on public.audit_log for select to authenticated
  using (public.is_admin_or_super(auth.uid()) and (project_id is null or public.can_see_project(auth.uid(), project_id)));
create policy "audit_log_insert_self" on public.audit_log for insert to authenticated with check (actor_id = auth.uid());

-- ============ TRIGGERS ============
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), coalesce(new.email,''))
  on conflict (id) do nothing;
  if not exists (select 1 from public.user_roles where role = 'super_admin') then
    insert into public.user_roles(user_id, role) values (new.id, 'super_admin');
  else
    insert into public.user_roles(user_id, role) values (new.id, 'user') on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger activities_touch before update on public.activities for each row execute function public.touch_updated_at();
