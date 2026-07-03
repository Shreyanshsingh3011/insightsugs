import { supabase } from "@/integrations/supabase/client";

export type AppRole = "super_admin" | "admin" | "user";

/**
 * Fetch the roles for the current signed-in user. Runs in the browser (the
 * managed `_authenticated` layout guarantees an auth session first). Safe to
 * call from `beforeLoad` in child routes.
 */
export async function fetchMyRoles(): Promise<AppRole[]> {
  const { data: userRes } = await supabase.auth.getUser();
  const uid = userRes.user?.id;
  if (!uid) return [];
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", uid);
  return (data ?? []).map((r) => r.role as AppRole);
}

export async function requireAnyRole(): Promise<AppRole[]> {
  const roles = await fetchMyRoles();
  return roles;
}
