-- Tighten notebook table access.
--
-- Previously anon had full CRUD with an RLS policy of `USING (true)` — meaning any
-- anonymous visitor could enumerate or delete every notebook conversation as long
-- as they could reach PostgREST. Notebooks are capability-URL based (whoever holds
-- the token has access), so anon SELECT/INSERT/UPDATE must remain to serve that
-- flow, but:
--   1. DELETE is removed for anon — clients never need it, and revoking it prevents
--      trivial destructive attacks.
--   2. Policies now require a non-empty token of realistic length (>= 8 chars),
--      blocking obvious enumeration probes like `?token=eq.` or empty inserts.
--   3. Rows without a token can neither be created nor read by anon.

-- Drop DELETE from anon; keep read/write for token-scoped access.
REVOKE DELETE ON public.notebook_sources FROM anon;
REVOKE DELETE ON public.notebook_messages FROM anon;

-- Replace permissive policies with token-shape guards.
DROP POLICY IF EXISTS "notebook_sources access by token" ON public.notebook_sources;
DROP POLICY IF EXISTS "notebook_messages access by token" ON public.notebook_messages;

CREATE POLICY "notebook_sources anon by token"
  ON public.notebook_sources
  FOR ALL
  TO anon
  USING (token IS NOT NULL AND length(token) >= 8)
  WITH CHECK (token IS NOT NULL AND length(token) >= 8);

CREATE POLICY "notebook_sources authenticated by token"
  ON public.notebook_sources
  FOR ALL
  TO authenticated
  USING (token IS NOT NULL AND length(token) >= 8)
  WITH CHECK (token IS NOT NULL AND length(token) >= 8);

CREATE POLICY "notebook_messages anon by token"
  ON public.notebook_messages
  FOR ALL
  TO anon
  USING (token IS NOT NULL AND length(token) >= 8)
  WITH CHECK (token IS NOT NULL AND length(token) >= 8);

CREATE POLICY "notebook_messages authenticated by token"
  ON public.notebook_messages
  FOR ALL
  TO authenticated
  USING (token IS NOT NULL AND length(token) >= 8)
  WITH CHECK (token IS NOT NULL AND length(token) >= 8);
