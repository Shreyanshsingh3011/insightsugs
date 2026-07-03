
CREATE TABLE public.briefing_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  sections text[] NOT NULL DEFAULT ARRAY['projects','sheets','documents','alerts']::text[],
  overdue_priority text NOT NULL DEFAULT 'top' CHECK (overdue_priority IN ('top','by_due_date','by_age')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.briefing_preferences TO authenticated;
GRANT ALL ON public.briefing_preferences TO service_role;

ALTER TABLE public.briefing_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own briefing preferences"
  ON public.briefing_preferences FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER briefing_preferences_updated_at
  BEFORE UPDATE ON public.briefing_preferences
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
