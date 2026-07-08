-- Audit trail for sheet sync + embedding rebuilds. Each row is one sync
-- attempt for one project, capturing timing, row diffs, and any embed run.
CREATE TABLE public.sheet_sync_audit (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  project_id   text NOT NULL,
  project_label text,
  sheet_url    text NOT NULL,
  tab_name     text,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  fetch_ms     integer,
  rows_total   integer,
  rows_added   integer DEFAULT 0,
  rows_removed integer DEFAULT 0,
  rows_changed integer DEFAULT 0,
  changed_row_indexes integer[] DEFAULT '{}',
  changed_columns text[] DEFAULT '{}',
  embed_ms         integer,
  embed_embedded   integer,
  embed_refreshed  integer,
  embed_remaining  integer,
  trigger_kind text NOT NULL DEFAULT 'auto' CHECK (trigger_kind IN ('auto','manual','initial')),
  warning text,
  error   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.sheet_sync_audit TO authenticated;
GRANT ALL ON public.sheet_sync_audit TO service_role;

ALTER TABLE public.sheet_sync_audit ENABLE ROW LEVEL SECURITY;

-- Any signed-in user records their own sync audit rows (client-driven).
CREATE POLICY "Insert own sync audit"
  ON public.sheet_sync_audit
  FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- Admins & super admins can read all; users see only their own runs.
CREATE POLICY "Read own or admin sees all"
  ON public.sheet_sync_audit
  FOR SELECT TO authenticated
  USING (actor_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

CREATE INDEX sheet_sync_audit_project_time_idx
  ON public.sheet_sync_audit (project_id, fetched_at DESC);
CREATE INDEX sheet_sync_audit_actor_time_idx
  ON public.sheet_sync_audit (actor_id, fetched_at DESC);
