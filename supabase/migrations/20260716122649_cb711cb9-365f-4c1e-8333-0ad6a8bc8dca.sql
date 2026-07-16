
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TABLE public.copilot_synonyms (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  term TEXT NOT NULL,
  term_normalized TEXT NOT NULL,
  sheet_id UUID NULL,
  column_name TEXT NULL,
  value TEXT NULL,
  note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX copilot_synonyms_user_term_uidx
  ON public.copilot_synonyms (user_id, term_normalized);
CREATE INDEX copilot_synonyms_user_idx
  ON public.copilot_synonyms (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.copilot_synonyms TO authenticated;
GRANT ALL ON public.copilot_synonyms TO service_role;

ALTER TABLE public.copilot_synonyms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own synonyms"
  ON public.copilot_synonyms FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER copilot_synonyms_updated_at
  BEFORE UPDATE ON public.copilot_synonyms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
