create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  subject text,
  body text not null,
  context_kind text,
  context_ref text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

grant select, insert, update on public.direct_messages to authenticated;
grant all on public.direct_messages to service_role;

create index if not exists direct_messages_recipient_idx
  on public.direct_messages (recipient_id, created_at desc);
create index if not exists direct_messages_sender_idx
  on public.direct_messages (sender_id, created_at desc);

alter table public.direct_messages enable row level security;

drop policy if exists dm_select_participant on public.direct_messages;
create policy dm_select_participant on public.direct_messages
  for select using (
    auth.uid() = sender_id
    or auth.uid() = recipient_id
    or public.is_admin_or_super(auth.uid())
  );

drop policy if exists dm_insert_sender on public.direct_messages;
create policy dm_insert_sender on public.direct_messages
  for insert with check (auth.uid() = sender_id);

drop policy if exists dm_update_recipient on public.direct_messages;
create policy dm_update_recipient on public.direct_messages
  for update using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);