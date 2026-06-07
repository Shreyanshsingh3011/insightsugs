
-- Integrations table (Emergent config)
CREATE TABLE public.integrations (
  key text PRIMARY KEY,
  base_url text NOT NULL DEFAULT '',
  api_key text NOT NULL DEFAULT '',
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integrations TO authenticated;
GRANT ALL ON public.integrations TO service_role;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integrations_super_all" ON public.integrations
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'super_admin'))
  WITH CHECK (public.has_role(auth.uid(),'super_admin'));

-- Concerns
CREATE TABLE public.concerns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raised_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  raised_by_dept text,
  target_dept text NOT NULL,
  registry_id uuid,
  row_index int,
  activity text,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'Medium' CHECK (severity IN ('Low','Medium','High','Critical')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  last_nudged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.concerns TO authenticated;
GRANT ALL ON public.concerns TO service_role;
ALTER TABLE public.concerns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "concerns_select" ON public.concerns
  FOR SELECT TO authenticated
  USING (
    public.is_admin_or_super(auth.uid())
    OR raised_by = auth.uid()
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.department = concerns.target_dept)
  );
CREATE POLICY "concerns_insert" ON public.concerns
  FOR INSERT TO authenticated
  WITH CHECK (raised_by = auth.uid());
CREATE POLICY "concerns_update" ON public.concerns
  FOR UPDATE TO authenticated
  USING (
    public.is_admin_or_super(auth.uid())
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.department = concerns.target_dept)
  );

CREATE TRIGGER concerns_touch BEFORE UPDATE ON public.concerns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX idx_concerns_target ON public.concerns(target_dept, status);
CREATE INDEX idx_concerns_raised_by ON public.concerns(raised_by, created_at DESC);

-- Concern messages
CREATE TABLE public.concern_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concern_id uuid NOT NULL REFERENCES public.concerns(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.concern_messages TO authenticated;
GRANT ALL ON public.concern_messages TO service_role;
ALTER TABLE public.concern_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "concern_messages_select" ON public.concern_messages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.concerns c
    WHERE c.id = concern_messages.concern_id AND (
      public.is_admin_or_super(auth.uid())
      OR c.raised_by = auth.uid()
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.department = c.target_dept)
    )
  ));
CREATE POLICY "concern_messages_insert" ON public.concern_messages
  FOR INSERT TO authenticated
  WITH CHECK (author_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.concerns c
    WHERE c.id = concern_messages.concern_id AND (
      public.is_admin_or_super(auth.uid())
      OR c.raised_by = auth.uid()
      OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.department = c.target_dept)
    )
  ));

CREATE INDEX idx_concern_messages_concern ON public.concern_messages(concern_id, created_at);
