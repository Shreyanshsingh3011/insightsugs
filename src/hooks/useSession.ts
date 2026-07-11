import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getUsableSupabaseSession, isUsableSession } from "@/lib/auth-session";
import { getMyRoles } from "@/lib/role-check.functions";

export type AppRole = "super_admin" | "admin" | "user";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let bootstrapped = false;
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      setSession(isUsableSession(s) ? s : null);
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED" || bootstrapped) {
        setLoading(false);
      }
    });
    getUsableSupabaseSession(2500, { validate: true })
      .then((restoredSession) => {
        if (!mounted) return;
        setSession(restoredSession);
      })
      .catch((error) => {
        if (!mounted) return;
        console.warn("[auth] Unable to restore session; continuing signed out", error);
        setSession(null);
      })
      .finally(() => {
        bootstrapped = true;
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, loading, userId: session?.user.id ?? null };
}

export function useRoles() {
  const { userId, loading } = useSession();
  const getRoles = useServerFn(getMyRoles);
  const query = useQuery({
    queryKey: ["roles", userId],
    enabled: !!userId && !loading,
    queryFn: async (): Promise<AppRole[]> => {
      const result = await getRoles();
      if (result.degraded) {
        console.warn("[auth] Role lookup recovered through the protected fallback path.");
      }
      return (result.roles ?? []).map((role) => role as AppRole);
    },
    retry: 2,
  });
  return { ...query, isLoading: loading || query.isLoading, isPending: loading || query.isPending };
}

export function useIsAdmin() {
  const { data: roles } = useRoles();
  return !!roles?.some((r) => r === "admin" || r === "super_admin");
}

export function useIsSuper() {
  const { data: roles } = useRoles();
  return !!roles?.includes("super_admin");
}
