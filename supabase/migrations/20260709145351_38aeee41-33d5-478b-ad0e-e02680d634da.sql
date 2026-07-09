
-- Speed up sheet_registry ORDER BY created_at DESC (admin lists)
CREATE INDEX IF NOT EXISTS idx_sheet_registry_created ON public.sheet_registry (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sheet_registry_updated ON public.sheet_registry (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sheet_registry_user_created ON public.sheet_registry (user_id, created_at DESC);

-- Speed up documents ORDER BY created_at DESC (dashboard doc list)
CREATE INDEX IF NOT EXISTS idx_documents_created ON public.documents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_owner_created ON public.documents (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_folder_created ON public.documents (folder_id, created_at DESC);

-- Functional index for cross-sheet activity/owner lookups (find_cross_sheet_rows)
CREATE INDEX IF NOT EXISTS idx_sheet_rows_canonical_activity_lower
  ON public.sheet_rows ((lower(btrim((canonical->>'activity')::text))));
CREATE INDEX IF NOT EXISTS idx_sheet_rows_canonical_owner_lower
  ON public.sheet_rows ((lower(btrim((canonical->>'owner')::text))));
