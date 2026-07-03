-- 1) Embeddings table for sheet rows (for agentic Copilot retrieval)
CREATE TABLE IF NOT EXISTS public.sheet_row_embeddings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_registry_id UUID NOT NULL REFERENCES public.sheet_registry(id) ON DELETE CASCADE,
  row_index      INT  NOT NULL,
  content_snippet TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  embedding      vector(1536) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sheet_registry_id, row_index)
);

CREATE INDEX IF NOT EXISTS sheet_row_embeddings_registry_idx
  ON public.sheet_row_embeddings (sheet_registry_id);

CREATE INDEX IF NOT EXISTS sheet_row_embeddings_hnsw_idx
  ON public.sheet_row_embeddings USING hnsw (embedding vector_cosine_ops);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sheet_row_embeddings TO authenticated;
GRANT ALL ON public.sheet_row_embeddings TO service_role;

ALTER TABLE public.sheet_row_embeddings ENABLE ROW LEVEL SECURITY;

-- Only the owner of the parent sheet_registry row (or admin/super_admin) can read/write.
CREATE POLICY "sheet_row_embeddings owner read"
  ON public.sheet_row_embeddings FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sheet_registry r
      WHERE r.id = sheet_row_embeddings.sheet_registry_id
        AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
    )
  );

CREATE POLICY "sheet_row_embeddings owner write"
  ON public.sheet_row_embeddings FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.sheet_registry r
      WHERE r.id = sheet_row_embeddings.sheet_registry_id
        AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sheet_registry r
      WHERE r.id = sheet_row_embeddings.sheet_registry_id
        AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
    )
  );

-- 2) Similarity search RPC. Uses SECURITY DEFINER + explicit user filter so RLS
--    on sheet_registry still gates by owner without recursive policy checks.
CREATE OR REPLACE FUNCTION public.match_sheet_rows(
  _user_id      UUID,
  _registry_id  UUID,
  _query        vector(1536),
  _match_count  INT DEFAULT 8
)
RETURNS TABLE (
  row_index  INT,
  snippet    TEXT,
  similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    e.row_index,
    e.content_snippet AS snippet,
    1 - (e.embedding <=> _query) AS similarity
  FROM public.sheet_row_embeddings e
  JOIN public.sheet_registry r ON r.id = e.sheet_registry_id
  WHERE e.sheet_registry_id = _registry_id
    AND (r.user_id = _user_id OR public.is_admin_or_super(_user_id))
  ORDER BY e.embedding <=> _query
  LIMIT GREATEST(_match_count, 1);
$$;

GRANT EXECUTE ON FUNCTION public.match_sheet_rows(UUID, UUID, vector, INT) TO authenticated, service_role;
