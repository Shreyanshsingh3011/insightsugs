-- Agent Inbox: pending AI-drafted actions awaiting human 1-click approval

CREATE TABLE public.agent_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_type text NOT NULL,               -- 'nudge' | 'escalation' | 'root_cause_ask' | 'investigation' | 'status_update' | 'digest' | 'custom'
  source_kind text NOT NULL,              -- 'person' | 'row' | 'project' | 'kpi' | 'anomaly' | 'cohort' | 'other'
  source_key text NOT NULL,               -- opaque identifier for the source entity (encoded)
  title text NOT NULL,                    -- short human-readable summary shown in the queue
  subject text,                           -- email subject (nullable for in-app-only messages)
  body text NOT NULL,                     -- markdown body
  channel text NOT NULL DEFAULT 'email',  -- 'email' | 'direct_message' | 'slack' | 'sheet_writeback'
  recipient_email text,
  recipient_user_id uuid,                 -- optional link to profiles.id
  cc jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array of {email,name} for email cc
  confidence numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  why text,                               -- plain-English reason the agent drafted this
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,  -- extra context: playbook_step, source_row_ref, metrics, links
  state text NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'dismissed' | 'snoozed' | 'sent' | 'failed'
  dismiss_reason text,
  snoozed_until timestamptz,
  assigned_to uuid,                       -- reviewer (profile id)
  created_by_rule text,                   -- rule slug (nullable, no FK until agent_rules exists)
  playbook_slug text,                     -- optional playbook grouping
  playbook_step int,
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  send_result jsonb,                      -- delivery metadata (message id, error, etc.)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_drafts_state_idx           ON public.agent_drafts (state, created_at DESC);
CREATE INDEX agent_drafts_assigned_idx        ON public.agent_drafts (assigned_to, state);
CREATE INDEX agent_drafts_source_idx          ON public.agent_drafts (source_kind, source_key);
CREATE INDEX agent_drafts_snoozed_idx         ON public.agent_drafts (snoozed_until) WHERE state = 'snoozed';
CREATE INDEX agent_drafts_playbook_idx        ON public.agent_drafts (playbook_slug, playbook_step);

-- Prevent duplicate pending drafts for the same source + type + assignee
CREATE UNIQUE INDEX agent_drafts_dedupe_pending_idx
  ON public.agent_drafts (draft_type, source_kind, source_key, COALESCE(assigned_to, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE state IN ('pending','snoozed');

GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_drafts TO authenticated;
GRANT ALL ON public.agent_drafts TO service_role;

ALTER TABLE public.agent_drafts ENABLE ROW LEVEL SECURITY;

-- SELECT: the assigned reviewer or any admin/super_admin
CREATE POLICY "Reviewers and admins can read drafts"
  ON public.agent_drafts
  FOR SELECT
  TO authenticated
  USING (
    assigned_to = auth.uid()
    OR public.is_admin_or_super(auth.uid())
  );

-- UPDATE: same audience (approve / dismiss / snooze / edit body)
CREATE POLICY "Reviewers and admins can update drafts"
  ON public.agent_drafts
  FOR UPDATE
  TO authenticated
  USING (
    assigned_to = auth.uid()
    OR public.is_admin_or_super(auth.uid())
  )
  WITH CHECK (
    assigned_to = auth.uid()
    OR public.is_admin_or_super(auth.uid())
  );

-- DELETE: admins only
CREATE POLICY "Admins can delete drafts"
  ON public.agent_drafts
  FOR DELETE
  TO authenticated
  USING (public.is_admin_or_super(auth.uid()));

-- INSERT is intentionally NOT granted to authenticated via policy — drafts are
-- produced by server code (service_role) via watchers, playbooks, and the
-- "Draft from answer" server function. This keeps the surface deterministic.

-- updated_at maintenance
CREATE OR REPLACE FUNCTION public.tg_agent_drafts_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_drafts_touch_updated_at
  BEFORE UPDATE ON public.agent_drafts
  FOR EACH ROW EXECUTE FUNCTION public.tg_agent_drafts_touch_updated_at();
