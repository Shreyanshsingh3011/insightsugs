
-- notifications: per-user in-app inbox
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null,
  title text not null,
  body text,
  activity_id uuid,
  project_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.notifications to authenticated;
grant all on public.notifications to service_role;
alter table public.notifications enable row level security;
create policy notifications_self_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_self_update on public.notifications for update to authenticated using (user_id = auth.uid());
create policy notifications_admin_read on public.notifications for select to authenticated using (is_admin_or_super(auth.uid()));
create policy notifications_service_insert on public.notifications for insert to authenticated with check (is_admin_or_super(auth.uid()) or user_id = auth.uid());
create index notifications_user_idx on public.notifications(user_id, created_at desc);

-- escalation_runs
create table public.escalation_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  overdue_count integer not null default 0,
  notifications_created integer not null default 0,
  details jsonb not null default '{}'::jsonb
);
grant select, insert on public.escalation_runs to authenticated;
grant all on public.escalation_runs to service_role;
alter table public.escalation_runs enable row level security;
create policy escalation_runs_admin_read on public.escalation_runs for select to authenticated using (is_admin_or_super(auth.uid()));

-- weekly_reports
create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz not null default now(),
  week_start date not null,
  week_end date not null,
  summary jsonb not null default '{}'::jsonb
);
grant select, insert on public.weekly_reports to authenticated;
grant all on public.weekly_reports to service_role;
alter table public.weekly_reports enable row level security;
create policy weekly_reports_admin_read on public.weekly_reports for select to authenticated using (is_admin_or_super(auth.uid()));
