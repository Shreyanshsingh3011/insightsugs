
ALTER TABLE public.pending_actions
  ADD COLUMN IF NOT EXISTS escalation_tier int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS escalation_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS pending_actions_escalation_idx
  ON public.pending_actions (status, escalation_tier, last_escalated_at);
