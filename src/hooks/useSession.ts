import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { getUsableSupabaseSession, isUsableSession } from "@/lib/auth-session";
import { isRecoverableDataReadError } from "@/lib/transient-errors";

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
    getUsableSupabaseSession()
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
  const query = useQuery({
    queryKey: ["roles", userId],
    enabled: !!userId && !loading,
    queryFn: async (): Promise<AppRole[]> => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userId!);
      if (error) {
        if (isRecoverableDataReadError(error)) {
          console.warn("[auth] Role lookup is temporarily unavailable; rendering workspace with user-level navigation.", error);
          return ["user"];
        }
        throw error;
      }
      return (data ?? []).map((r) => r.role as AppRole);
    },
    retry: (failureCount, error) => !isRecoverableDataReadError(error) && failureCount < 2,
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
