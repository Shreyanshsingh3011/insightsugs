
-- 1) user_project_assignments
CREATE TABLE IF NOT EXISTS public.user_project_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_key text NOT NULL,
  project_label text NOT NULL,
  is_leader boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, project_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_project_assignments TO authenticated;
GRANT ALL ON public.user_project_assignments TO service_role;
ALTER TABLE public.user_project_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "upa_self_read" ON public.user_project_assignments
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));
CREATE POLICY "upa_self_write" ON public.user_project_assignments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));
CREATE POLICY "upa_self_update" ON public.user_project_assignments
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()))
  WITH CHECK (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));
CREATE POLICY "upa_self_delete" ON public.user_project_assignments
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin_or_super(auth.uid()));

-- 2) doc_folders: add parent_id for nested folders
ALTER TABLE public.doc_folders
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.doc_folders(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS doc_folders_parent_id_idx ON public.doc_folders(parent_id);

-- 3) delete_doc_folder RPC (admin/super only)
CREATE OR REPLACE FUNCTION public.delete_doc_folder(_folder_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  doc_count int;
BEGIN
  IF NOT public.is_admin_or_super(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can delete folders';
  END IF;

  WITH RECURSIVE tree AS (
    SELECT id FROM public.doc_folders WHERE id = _folder_id
    UNION ALL
    SELECT f.id FROM public.doc_folders f
    JOIN tree t ON f.parent_id = t.id
  )
  SELECT count(*) INTO doc_count
  FROM public.documents
  WHERE folder_id IN (SELECT id FROM tree);

  IF doc_count > 0 THEN
    RAISE EXCEPTION 'Folder is not empty (% documents). Delete or move documents first.', doc_count;
  END IF;

  DELETE FROM public.doc_folders WHERE id = _folder_id;
END;
$$;

-- 4) set_my_project_assignments RPC — atomic replace of caller's own set
CREATE OR REPLACE FUNCTION public.set_my_project_assignments(
  _keys text[],
  _labels text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  i int;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF array_length(_keys, 1) IS DISTINCT FROM array_length(_labels, 1) THEN
    RAISE EXCEPTION 'Keys and labels must have the same length';
  END IF;

  DELETE FROM public.user_project_assignments WHERE user_id = uid;

  IF _keys IS NOT NULL THEN
    FOR i IN 1..coalesce(array_length(_keys, 1), 0) LOOP
      INSERT INTO public.user_project_assignments (user_id, project_key, project_label)
      VALUES (uid, _keys[i], _labels[i])
      ON CONFLICT (user_id, project_key) DO NOTHING;
    END LOOP;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_doc_folder(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_project_assignments(text[], text[]) TO authenticated;
