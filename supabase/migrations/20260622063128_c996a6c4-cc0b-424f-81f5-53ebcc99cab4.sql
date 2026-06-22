CREATE TABLE public.notebook_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  type text NOT NULL CHECK (type IN ('sheet','concerns','reminders')),
  label text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  summary text,
  summary_generated_at timestamptz,
  row_count int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token, type, label)
);

CREATE TABLE public.notebook_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','system')),
  content text NOT NULL DEFAULT '',
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notebook_messages_token_created_idx ON public.notebook_messages(token, created_at);
CREATE INDEX notebook_sources_token_idx ON public.notebook_sources(token);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebook_sources TO anon, authenticated;
GRANT ALL ON public.notebook_sources TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notebook_messages TO anon, authenticated;
GRANT ALL ON public.notebook_messages TO service_role;

ALTER TABLE public.notebook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notebook_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notebook_sources access by token" ON public.notebook_sources
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "notebook_messages access by token" ON public.notebook_messages
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER notebook_sources_touch_updated_at
  BEFORE UPDATE ON public.notebook_sources
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();