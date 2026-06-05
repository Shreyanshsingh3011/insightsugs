
-- Alerts: persisted dispatch record for flagged activities
CREATE TABLE public.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id text NOT NULL UNIQUE,
  activity text NOT NULL,
  stage text,
  severity text,
  source text,
  root_cause text,
  reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  sent_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.alert_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.alerts(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email text NOT NULL,
  name text,
  channel text NOT NULL CHECK (channel IN ('inapp','email')),
  delivered_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_recipients_alert ON public.alert_recipients(alert_id);
CREATE INDEX idx_alert_recipients_user ON public.alert_recipients(user_id);
GRANT SELECT, INSERT, UPDATE ON public.alert_recipients TO authenticated;
GRANT ALL ON public.alert_recipients TO service_role;
ALTER TABLE public.alert_recipients ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.alert_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id uuid NOT NULL REFERENCES public.alerts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_alert_messages_alert ON public.alert_messages(alert_id, created_at);
GRANT SELECT, INSERT ON public.alert_messages TO authenticated;
GRANT ALL ON public.alert_messages TO service_role;
ALTER TABLE public.alert_messages ENABLE ROW LEVEL SECURITY;

-- Helper: is user a recipient of this alert?
CREATE OR REPLACE FUNCTION public.is_alert_recipient(_alert_id uuid, _user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.alert_recipients WHERE alert_id = _alert_id AND user_id = _user_id);
$$;

-- alerts policies
CREATE POLICY alerts_select ON public.alerts FOR SELECT TO authenticated
  USING (public.is_admin_or_super(auth.uid()) OR sent_by = auth.uid() OR public.is_alert_recipient(id, auth.uid()));
CREATE POLICY alerts_insert ON public.alerts FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_or_super(auth.uid()) AND sent_by = auth.uid());
CREATE POLICY alerts_update ON public.alerts FOR UPDATE TO authenticated
  USING (public.is_admin_or_super(auth.uid()))
  WITH CHECK (public.is_admin_or_super(auth.uid()));

-- recipients policies
CREATE POLICY alert_recipients_select ON public.alert_recipients FOR SELECT TO authenticated
  USING (public.is_admin_or_super(auth.uid()) OR user_id = auth.uid() OR EXISTS(SELECT 1 FROM public.alerts a WHERE a.id = alert_id AND a.sent_by = auth.uid()));
CREATE POLICY alert_recipients_insert ON public.alert_recipients FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_or_super(auth.uid()));
CREATE POLICY alert_recipients_update ON public.alert_recipients FOR UPDATE TO authenticated
  USING (public.is_admin_or_super(auth.uid()))
  WITH CHECK (public.is_admin_or_super(auth.uid()));

-- messages policies
CREATE POLICY alert_messages_select ON public.alert_messages FOR SELECT TO authenticated
  USING (
    public.is_admin_or_super(auth.uid())
    OR public.is_alert_recipient(alert_id, auth.uid())
    OR EXISTS(SELECT 1 FROM public.alerts a WHERE a.id = alert_id AND a.sent_by = auth.uid())
  );
CREATE POLICY alert_messages_insert ON public.alert_messages FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      public.is_admin_or_super(auth.uid())
      OR public.is_alert_recipient(alert_id, auth.uid())
    )
  );

CREATE TRIGGER trg_alerts_updated_at BEFORE UPDATE ON public.alerts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
