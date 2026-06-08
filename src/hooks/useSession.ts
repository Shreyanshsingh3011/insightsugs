import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "super_admin" | "admin" | "user";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
    });
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
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
      if (error) throw error;
      return (data ?? []).map((r) => r.role as AppRole);
    },
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
