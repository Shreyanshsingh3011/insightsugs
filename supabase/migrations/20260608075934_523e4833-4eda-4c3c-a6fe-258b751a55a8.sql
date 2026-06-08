
ALTER TABLE public.integrations
  ADD COLUMN IF NOT EXISTS environments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_env text;

-- Backfill: if environments is empty but base_url/api_key set, seed a single "Production" env
UPDATE public.integrations
SET environments = jsonb_build_array(
      jsonb_build_object(
        'id', 'prod',
        'name', 'Production',
        'base_url', base_url,
        'api_key', api_key
      )
    ),
    active_env = 'prod'
WHERE (environments IS NULL OR jsonb_array_length(environments) = 0)
  AND coalesce(base_url, '') <> '';
