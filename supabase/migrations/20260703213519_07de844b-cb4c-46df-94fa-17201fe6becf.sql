
CREATE OR REPLACE FUNCTION public.match_all_sheet_rows(_user_id uuid, _query vector, _match_count integer DEFAULT 8)
 RETURNS TABLE(sheet_registry_id uuid, sheet_name text, row_index integer, snippet text, similarity double precision)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT r.id, r.display_name, e.row_index, e.content_snippet, 1 - (e.embedding <=> _query)
  FROM public.sheet_row_embeddings e
  JOIN public.sheet_registry r ON r.id = e.sheet_registry_id
  WHERE public.can_read_sheet(_user_id, r.id, r.user_id, r.visibility)
  ORDER BY e.embedding <=> _query
  LIMIT GREATEST(_match_count, 1);
$$;

GRANT EXECUTE ON FUNCTION public.match_all_sheet_rows(uuid, vector, integer) TO authenticated, service_role;
