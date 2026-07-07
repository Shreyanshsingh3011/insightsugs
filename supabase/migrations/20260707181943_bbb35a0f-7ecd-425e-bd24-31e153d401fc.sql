CREATE TABLE public.digest_reply_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_kind text NOT NULL,
  digest_ref text,
  pending_action_ids uuid[] NOT NULL DEFAULT '{}',
  project_ids uuid[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_digest_reply_tokens_token ON public.digest_reply_tokens(token);
CREATE INDEX idx_digest_reply_tokens_user ON public.digest_reply_tokens(user_id);
CREATE INDEX idx_digest_reply_tokens_expires ON public.digest_reply_tokens(expires_at);

GRANT ALL ON public.digest_reply_tokens TO service_role;

ALTER TABLE public.digest_reply_tokens ENABLE ROW LEVEL SECURITY;

-- No user-facing policies: this table is service-role-only. Inbound webhook
-- (server-side, with supabaseAdmin) is the only reader/writer.

-- Log of processed inbound emails for idempotency + audit
CREATE TABLE public.inbound_email_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_message_id text UNIQUE,
  token text,
  from_email text NOT NULL,
  subject text,
  raw_body text,
  parsed_commands jsonb NOT NULL DEFAULT '[]'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'received',
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_inbound_email_events_created ON public.inbound_email_events(created_at DESC);
CREATE INDEX idx_inbound_email_events_token ON public.inbound_email_events(token);

GRANT ALL ON public.inbound_email_events TO service_role;
GRANT SELECT ON public.inbound_email_events TO authenticated;

ALTER TABLE public.inbound_email_events ENABLE ROW LEVEL SECURITY;

-- Admins can view the audit log
CREATE POLICY "Admins view inbound email events"
  ON public.inbound_email_events FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'super_admin'));