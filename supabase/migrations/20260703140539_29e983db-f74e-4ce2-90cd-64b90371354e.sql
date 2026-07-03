
-- 1) Enum
DO $$ BEGIN
  CREATE TYPE public.content_visibility AS ENUM ('private','public','shared');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Columns
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS visibility public.content_visibility NOT NULL DEFAULT 'private';
ALTER TABLE public.sheet_registry
  ADD COLUMN IF NOT EXISTS visibility public.content_visibility NOT NULL DEFAULT 'private';

-- 3) Share tables
CREATE TABLE IF NOT EXISTS public.document_shares (
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (document_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_shares TO authenticated;
GRANT ALL ON public.document_shares TO service_role;
ALTER TABLE public.document_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_shares admin write"
  ON public.document_shares FOR ALL TO authenticated
  USING (public.is_admin_or_super(auth.uid()))
  WITH CHECK (public.is_admin_or_super(auth.uid()));
CREATE POLICY "document_shares self read"
  ON public.document_shares FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

CREATE INDEX IF NOT EXISTS document_shares_user_idx ON public.document_shares(user_id);

CREATE TABLE IF NOT EXISTS public.sheet_registry_shares (
  sheet_registry_id uuid NOT NULL REFERENCES public.sheet_registry(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (sheet_registry_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sheet_registry_shares TO authenticated;
GRANT ALL ON public.sheet_registry_shares TO service_role;
ALTER TABLE public.sheet_registry_shares ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sheet_registry_shares admin write"
  ON public.sheet_registry_shares FOR ALL TO authenticated
  USING (public.is_admin_or_super(auth.uid()))
  WITH CHECK (public.is_admin_or_super(auth.uid()));
CREATE POLICY "sheet_registry_shares self read"
  ON public.sheet_registry_shares FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

CREATE INDEX IF NOT EXISTS sheet_registry_shares_user_idx ON public.sheet_registry_shares(user_id);

-- 4) Access-check helpers (SECURITY DEFINER so RLS on share tables never
--    causes infinite recursion when reading via SELECT policies).
CREATE OR REPLACE FUNCTION public.can_read_document(_user_id uuid, _doc_id uuid, _owner_id uuid, _visibility public.content_visibility)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    _owner_id = _user_id
    OR public.is_admin_or_super(_user_id)
    OR _visibility = 'public'
    OR (_visibility = 'shared' AND EXISTS (
      SELECT 1 FROM public.document_shares s
      WHERE s.document_id = _doc_id AND s.user_id = _user_id
    ));
$$;

CREATE OR REPLACE FUNCTION public.can_read_sheet(_user_id uuid, _registry_id uuid, _owner_id uuid, _visibility public.content_visibility)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    _owner_id = _user_id
    OR public.is_admin_or_super(_user_id)
    OR _visibility = 'public'
    OR (_visibility = 'shared' AND EXISTS (
      SELECT 1 FROM public.sheet_registry_shares s
      WHERE s.sheet_registry_id = _registry_id AND s.user_id = _user_id
    ));
$$;

-- 5) Rewrite RLS on documents / document_chunks
DROP POLICY IF EXISTS documents_admin_read ON public.documents;
DROP POLICY IF EXISTS documents_owner_all ON public.documents;

CREATE POLICY documents_read
  ON public.documents FOR SELECT TO authenticated
  USING (public.can_read_document(auth.uid(), id, owner_id, visibility));
CREATE POLICY documents_owner_write
  ON public.documents FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY documents_owner_update
  ON public.documents FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  WITH CHECK (owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()));
CREATE POLICY documents_owner_delete
  ON public.documents FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

DROP POLICY IF EXISTS document_chunks_admin_read ON public.document_chunks;
DROP POLICY IF EXISTS document_chunks_owner_all ON public.document_chunks;

CREATE POLICY document_chunks_read
  ON public.document_chunks FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.documents d
    WHERE d.id = document_chunks.document_id
      AND public.can_read_document(auth.uid(), d.id, d.owner_id, d.visibility)
  ));
CREATE POLICY document_chunks_owner_write
  ON public.document_chunks FOR ALL TO authenticated
  USING (owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  WITH CHECK (owner_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

-- 6) Rewrite RLS on sheet_registry / sheet_rows / sheet_row_embeddings
DROP POLICY IF EXISTS sheet_registry_owner_all ON public.sheet_registry;

CREATE POLICY sheet_registry_read
  ON public.sheet_registry FOR SELECT TO authenticated
  USING (public.can_read_sheet(auth.uid(), id, user_id, visibility));
CREATE POLICY sheet_registry_owner_write
  ON public.sheet_registry FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY sheet_registry_owner_update
  ON public.sheet_registry FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));
CREATE POLICY sheet_registry_owner_delete
  ON public.sheet_registry FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

DROP POLICY IF EXISTS sheet_rows_owner_all ON public.sheet_rows;

CREATE POLICY sheet_rows_read
  ON public.sheet_rows FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_rows.sheet_registry_id
      AND public.can_read_sheet(auth.uid(), r.id, r.user_id, r.visibility)
  ));
CREATE POLICY sheet_rows_owner_write
  ON public.sheet_rows FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_rows.sheet_registry_id
      AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_rows.sheet_registry_id
      AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  ));

DROP POLICY IF EXISTS "sheet_row_embeddings owner read" ON public.sheet_row_embeddings;
DROP POLICY IF EXISTS "sheet_row_embeddings owner write" ON public.sheet_row_embeddings;

CREATE POLICY sheet_row_embeddings_read
  ON public.sheet_row_embeddings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_row_embeddings.sheet_registry_id
      AND public.can_read_sheet(auth.uid(), r.id, r.user_id, r.visibility)
  ));
CREATE POLICY sheet_row_embeddings_write
  ON public.sheet_row_embeddings FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_row_embeddings.sheet_registry_id
      AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.sheet_registry r
    WHERE r.id = sheet_row_embeddings.sheet_registry_id
      AND (r.user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  ));

-- 7) Update RPCs to honor visibility
CREATE OR REPLACE FUNCTION public.match_sheet_rows(_user_id uuid, _registry_id uuid, _query vector, _match_count integer DEFAULT 8)
 RETURNS TABLE(row_index integer, snippet text, similarity double precision)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT e.row_index, e.content_snippet AS snippet, 1 - (e.embedding <=> _query) AS similarity
  FROM public.sheet_row_embeddings e
  JOIN public.sheet_registry r ON r.id = e.sheet_registry_id
  WHERE e.sheet_registry_id = _registry_id
    AND public.can_read_sheet(_user_id, r.id, r.user_id, r.visibility)
  ORDER BY e.embedding <=> _query
  LIMIT GREATEST(_match_count, 1);
$function$;

CREATE OR REPLACE FUNCTION public.match_doc_chunks(_user_id uuid, _query vector, _scope_folder uuid, _scope_document uuid, _match_count integer DEFAULT 6)
 RETURNS TABLE(chunk_id uuid, document_id uuid, document_name text, page_no integer, content text, similarity double precision)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT c.id AS chunk_id, d.id AS document_id, d.name AS document_name,
         c.page_no, c.content, 1 - (c.embedding <=> _query) AS similarity
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.embedding IS NOT NULL
    AND public.can_read_document(_user_id, d.id, d.owner_id, d.visibility)
    AND (_scope_folder IS NULL OR d.folder_id = _scope_folder)
    AND (_scope_document IS NULL OR d.id = _scope_document)
  ORDER BY c.embedding <=> _query
  LIMIT GREATEST(_match_count, 1);
$function$;
