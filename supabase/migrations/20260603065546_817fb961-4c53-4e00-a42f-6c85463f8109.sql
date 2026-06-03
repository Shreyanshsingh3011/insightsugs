-- Drop google_connections table (no longer used)
DROP TABLE IF EXISTS public.google_connections CASCADE;

-- Reshape sheet_registry: replace google_sheet_id + tab_name with apps_script_url
ALTER TABLE public.sheet_registry
  DROP COLUMN IF EXISTS google_sheet_id,
  DROP COLUMN IF EXISTS tab_name,
  ADD COLUMN IF NOT EXISTS apps_script_url text NOT NULL DEFAULT '';

-- Drop the default after column exists so future inserts must supply it
ALTER TABLE public.sheet_registry
  ALTER COLUMN apps_script_url DROP DEFAULT;
