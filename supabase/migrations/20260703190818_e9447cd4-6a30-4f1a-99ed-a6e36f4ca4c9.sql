-- weekly_briefings
CREATE TABLE public.weekly_briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('user','org')),
  week_start date NOT NULL,
  week_end date NOT NULL,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_markdown text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX weekly_briefings_user_week_key
  ON public.weekly_briefings (COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, week_start);
CREATE INDEX weekly_briefings_user_idx ON public.weekly_briefings (user_id, week_start DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_briefings TO authenticated;
GRANT ALL ON public.weekly_briefings TO service_role;
ALTER TABLE public.weekly_briefings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own briefing" ON public.weekly_briefings
  FOR SELECT TO authenticated
  USING (
    (scope = 'user' AND user_id = auth.uid())
    OR public.is_admin_or_super(auth.uid())
  );

-- smart_alert_rules
CREATE TABLE public.smart_alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'keyword' CHECK (kind IN ('keyword')),
  phrase text NOT NULL,
  target text NOT NULL DEFAULT 'both' CHECK (target IN ('documents','sheet_rows','both')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX smart_alert_rules_active_idx ON public.smart_alert_rules (is_active) WHERE is_active;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.smart_alert_rules TO authenticated;
GRANT ALL ON public.smart_alert_rules TO service_role;
ALTER TABLE public.smart_alert_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage keyword rules" ON public.smart_alert_rules
  FOR ALL TO authenticated
  USING (public.is_admin_or_super(auth.uid()))
  WITH CHECK (public.is_admin_or_super(auth.uid()));

CREATE TRIGGER smart_alert_rules_touch
  BEFORE UPDATE ON public.smart_alert_rules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- smart_alert_state (idempotency)
CREATE TABLE public.smart_alert_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_kind text NOT NULL,
  ref_key text NOT NULL,
  last_raised_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_kind, ref_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.smart_alert_state TO authenticated;
GRANT ALL ON public.smart_alert_state TO service_role;
ALTER TABLE public.smart_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read smart alert state" ON public.smart_alert_state
  FOR SELECT TO authenticated
  USING (public.is_admin_or_super(auth.uid()));