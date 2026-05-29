
-- pgvector for embeddings
create extension if not exists vector;

-- =========================
-- doc_folders
-- =========================
create table public.doc_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  parent_id uuid references public.doc_folders(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index doc_folders_owner_idx on public.doc_folders(owner_id);

grant select, insert, update, delete on public.doc_folders to authenticated;
grant all on public.doc_folders to service_role;

alter table public.doc_folders enable row level security;

create policy doc_folders_owner_all on public.doc_folders
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy doc_folders_admin_read on public.doc_folders
  for select to authenticated
  using (is_admin_or_super(auth.uid()));

-- =========================
-- documents
-- =========================
create type public.document_status as enum ('pending','processing','ready','failed');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  folder_id uuid references public.doc_folders(id) on delete set null,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  storage_path text not null,
  status public.document_status not null default 'pending',
  status_error text,
  summary text,
  key_points jsonb,
  page_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_owner_idx on public.documents(owner_id);
create index documents_folder_idx on public.documents(folder_id);

grant select, insert, update, delete on public.documents to authenticated;
grant all on public.documents to service_role;

alter table public.documents enable row level security;

create policy documents_owner_all on public.documents
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy documents_admin_read on public.documents
  for select to authenticated
  using (is_admin_or_super(auth.uid()));

create trigger documents_touch
before update on public.documents
for each row execute function public.touch_updated_at();

-- =========================
-- document_chunks
-- =========================
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  owner_id uuid not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(768),
  token_count integer,
  page_no integer,
  created_at timestamptz not null default now()
);
create index document_chunks_doc_idx on public.document_chunks(document_id);
create index document_chunks_owner_idx on public.document_chunks(owner_id);
create index document_chunks_embedding_idx
  on public.document_chunks using hnsw (embedding vector_cosine_ops);

grant select, insert, update, delete on public.document_chunks to authenticated;
grant all on public.document_chunks to service_role;

alter table public.document_chunks enable row level security;

create policy document_chunks_owner_all on public.document_chunks
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy document_chunks_admin_read on public.document_chunks
  for select to authenticated
  using (is_admin_or_super(auth.uid()));

-- =========================
-- copilot_messages
-- =========================
create table public.copilot_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  scope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index copilot_messages_user_idx on public.copilot_messages(user_id, created_at);

grant select, insert, update, delete on public.copilot_messages to authenticated;
grant all on public.copilot_messages to service_role;

alter table public.copilot_messages enable row level security;

create policy copilot_messages_owner_all on public.copilot_messages
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =========================
-- Storage bucket + policies
-- =========================
insert into storage.buckets (id, name, public)
values ('documents','documents', false)
on conflict (id) do nothing;

create policy "docs_owner_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (auth.uid())::text = (storage.foldername(name))[1]);

create policy "docs_owner_write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and (auth.uid())::text = (storage.foldername(name))[1]);

create policy "docs_owner_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'documents' and (auth.uid())::text = (storage.foldername(name))[1]);

create policy "docs_owner_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (auth.uid())::text = (storage.foldername(name))[1]);

create policy "docs_admin_read"
  on storage.objects for select to authenticated
  using (bucket_id = 'documents' and is_admin_or_super(auth.uid()));

-- =========================
-- Seed default folders
-- =========================
create or replace function public.seed_default_doc_folders(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cat text;
  defaults text[] := array[
    'PERT charts',
    'Rental formats',
    'JMC formats',
    'Billing formats',
    'Customer letters',
    'Govt-agency letters',
    'Time-extension requests',
    'Uncategorized'
  ];
begin
  if exists (select 1 from public.doc_folders where owner_id = _user_id) then
    return;
  end if;
  foreach cat in array defaults loop
    insert into public.doc_folders (owner_id, name) values (_user_id, cat);
  end loop;
end;
$$;

grant execute on function public.seed_default_doc_folders(uuid) to authenticated;

-- =========================
-- Vector similarity search
-- =========================
create or replace function public.match_doc_chunks(
  _user_id uuid,
  _query vector(768),
  _scope_folder uuid,
  _scope_document uuid,
  _match_count int default 6
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_name text,
  page_no integer,
  content text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id as chunk_id,
    d.id as document_id,
    d.name as document_name,
    c.page_no,
    c.content,
    1 - (c.embedding <=> _query) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id
  where
    c.embedding is not null
    and (
      d.owner_id = _user_id
      or public.is_admin_or_super(_user_id)
    )
    and (_scope_folder is null or d.folder_id = _scope_folder)
    and (_scope_document is null or d.id = _scope_document)
  order by c.embedding <=> _query
  limit greatest(_match_count, 1);
$$;

grant execute on function public.match_doc_chunks(uuid, vector, uuid, uuid, int) to authenticated;
