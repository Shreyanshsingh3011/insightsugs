
-- Sheet type enum
create type public.sheet_type as enum (
  'progress',
  'material_reconciliation',
  'procurement',
  'contractor_billing',
  'bill_tracking',
  'pms',
  'tat'
);

-- Per-user Google OAuth connection (App User Connector)
create table public.google_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  connection_id text not null,
  google_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.google_connections to authenticated;
grant all on public.google_connections to service_role;

alter table public.google_connections enable row level security;

create policy "google_connections_owner_all" on public.google_connections
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger google_connections_touch
  before update on public.google_connections
  for each row execute function public.touch_updated_at();

-- Registered sheets per user
create table public.sheet_registry (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sheet_type public.sheet_type not null,
  google_sheet_id text not null,
  tab_name text not null default 'Sheet1',
  display_name text not null,
  last_refreshed_at timestamptz,
  row_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.sheet_registry to authenticated;
grant all on public.sheet_registry to service_role;

alter table public.sheet_registry enable row level security;

create policy "sheet_registry_owner_all" on public.sheet_registry
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger sheet_registry_touch
  before update on public.sheet_registry
  for each row execute function public.touch_updated_at();

create index sheet_registry_user_idx on public.sheet_registry(user_id);

-- Column mappings: messy source header -> canonical field
create table public.sheet_column_mappings (
  id uuid primary key default gen_random_uuid(),
  sheet_registry_id uuid not null references public.sheet_registry(id) on delete cascade,
  source_header text not null,
  canonical_field text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.sheet_column_mappings to authenticated;
grant all on public.sheet_column_mappings to service_role;

alter table public.sheet_column_mappings enable row level security;

create policy "sheet_column_mappings_owner_all" on public.sheet_column_mappings
  for all to authenticated
  using (exists (select 1 from public.sheet_registry r where r.id = sheet_registry_id and r.user_id = auth.uid()))
  with check (exists (select 1 from public.sheet_registry r where r.id = sheet_registry_id and r.user_id = auth.uid()));

create index sheet_column_mappings_reg_idx on public.sheet_column_mappings(sheet_registry_id);

-- Normalized rows (full-replace on each refresh)
create table public.sheet_rows (
  id uuid primary key default gen_random_uuid(),
  sheet_registry_id uuid not null references public.sheet_registry(id) on delete cascade,
  row_index integer not null,
  canonical jsonb not null default '{}'::jsonb,
  extras jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on public.sheet_rows to authenticated;
grant all on public.sheet_rows to service_role;

alter table public.sheet_rows enable row level security;

create policy "sheet_rows_owner_all" on public.sheet_rows
  for all to authenticated
  using (exists (select 1 from public.sheet_registry r where r.id = sheet_registry_id and r.user_id = auth.uid()))
  with check (exists (select 1 from public.sheet_registry r where r.id = sheet_registry_id and r.user_id = auth.uid()));

create index sheet_rows_reg_idx on public.sheet_rows(sheet_registry_id, row_index);
