import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useRoles, useSession } from "./useSession";
import { listMyAssignments, type Assignment } from "@/lib/user-assignments.functions";
import { isRecoverableDataReadError } from "@/lib/transient-errors";

export type ScopeMode = "all" | "assigned" | "name-scoped";

export type AgentScope = {
  mode: ScopeMode;
  loading: boolean;
  assignments: Assignment[];
  allowedProjectKeys: Set<string> | null; // null = allow all
  nameNeedles: string[]; // lowercased strings used to filter rows to the user
  profile: { full_name: string; email: string } | null;
  isAdmin: boolean;
  isSuper: boolean;
};

// Returns the row-level scope for the current caller. Super admins (MD, VH)
// see every project; admins (RM) see only projects they're assigned to;
// users see their assigned projects AND only rows that mention them by
// name/email in the Responsible Person / email columns.
export function useAgentScope(): AgentScope {
  const { session, userId, loading: sessionLoading } = useSession();
  const { data: roles } = useRoles();
  const isSuper = !!roles?.includes("super_admin");
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");

  const listFn = useServerFn(listMyAssignments);
  const assignQ = useQuery({
    queryKey: ["my-assignments", userId],
    enabled: !!userId && !sessionLoading,
    queryFn: async () => {
      try {
        return await listFn({ data: undefined as any });
      } catch (error) {
        if (isRecoverableDataReadError(error)) {
          console.warn("[assignments] Project assignments unavailable; continuing with an empty scope.", error);
          return { assignments: [] as Assignment[] };
        }
        throw error;
      }
    },
    staleTime: 30_000,
    retry: (failureCount, error) => !isRecoverableDataReadError(error) && failureCount < 2,
  });

  const [profile, setProfile] = useState<{ full_name: string; email: string } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!userId) { setProfile(null); return; }
    void (async () => {
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("full_name, email")
          .eq("id", userId)
          .maybeSingle();
        if (!alive) return;
        if (error) {
          console.warn("[profiles] Current profile lookup unavailable; using session email only.", error);
        }
        setProfile({
          full_name: (data?.full_name ?? "").trim(),
          email: (data?.email ?? session?.user.email ?? "").trim().toLowerCase(),
        });
      } catch (error) {
        if (!alive) return;
        console.warn("[profiles] Current profile lookup failed; using session email only.", error);
        setProfile({ full_name: "", email: (session?.user.email ?? "").trim().toLowerCase() });
      }
    })();
    return () => { alive = false; };
  }, [userId, session?.user.email]);

  const assignments = assignQ.data?.assignments ?? [];

  const mode: ScopeMode = isSuper ? "all" : isAdmin ? "assigned" : "name-scoped";
  const allowedProjectKeys = mode === "all"
    ? null
    : new Set(assignments.map((a) => a.project_key));

  const needles: string[] = [];
  if (profile?.email) needles.push(profile.email.toLowerCase());
  if (profile?.full_name) {
    const n = profile.full_name.trim().toLowerCase();
    if (n.length >= 2) needles.push(n);
    // add first + last name tokens for looser matching
    const parts = n.split(/\s+/).filter((p) => p.length >= 3);
    for (const p of parts) if (!needles.includes(p)) needles.push(p);
  }

  return {
    mode,
    loading: assignQ.isLoading || roles === undefined,
    assignments,
    allowedProjectKeys,
    nameNeedles: needles,
    profile,
    isAdmin,
    isSuper,
  };
}

// Test whether a given row from a sheet payload should be visible to the current user.
export function rowMatchesUser(row: Record<string, unknown>, needles: string[]): boolean {
  if (needles.length === 0) return false;
  const parts = [
    row["Responsible Person"], row["Responsibility"], row["approvers name"],
    row["Responsible Person Emp ID"], row["Responsible Person Mail ID"],
    row["approvers email id"], row["Reporting Manager Email"],
  ];
  const hay = parts
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v).toLowerCase())
    .join(" | ");
  if (!hay) return false;
  return needles.some((n) => hay.includes(n));
}
