// Server-only DB refresh for the bootstrap super admin set. Cached in-memory
// on the worker for 5 minutes. Falls back silently to the hardcoded list.

import { mergeBootstrapSuperAdmins } from "./bootstrap-super-admins";

let lastRefreshAt = 0;
let inflight: Promise<void> | null = null;
const REFRESH_MS = 5 * 60 * 1000;

export async function refreshBootstrapSuperAdminsFromDb(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastRefreshAt < REFRESH_MS) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("bootstrap_admins")
        .select("email, user_id");
      if (error) {
        console.warn("[bootstrap-admins] refresh failed:", error.message);
        return;
      }
      if (data && data.length) {
        mergeBootstrapSuperAdmins(data as { email: string | null; user_id: string | null }[]);
      }
      lastRefreshAt = Date.now();
    } catch (e) {
      console.warn("[bootstrap-admins] refresh threw:", (e as Error).message);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
