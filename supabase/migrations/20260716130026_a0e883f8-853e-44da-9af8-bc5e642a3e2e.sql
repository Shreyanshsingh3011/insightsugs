CREATE TABLE public.copilot_clarify_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sheet_ids UUID[] NOT NULL DEFAULT '{}',
  document_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','expired')),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  question TEXT,
  resolved_scope JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.copilot_clarify_sessions TO authenticated;
GRANT ALL ON public.copilot_clarify_sessions TO service_role;
ALTER TABLE public.copilot_clarify_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage their own clarify sessions"
  ON public.copilot_clarify_sessions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE INDEX copilot_clarify_sessions_user_created_idx
  ON public.copilot_clarify_sessions(user_id, created_at DESC);
CREATE OR REPLACE FUNCTION public.copilot_clarify_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER copilot_clarify_sessions_touch_updated_at
  BEFORE UPDATE ON public.copilot_clarify_sessions
  FOR EACH ROW EXECUTE FUNCTION public.copilot_clarify_touch_updated_at();