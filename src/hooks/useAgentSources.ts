// Shared hook: mirrors AgentDashboard's fetching + filtering EXACTLY so entity
// detail pages (project health, KPI drilldowns, person/stage/row views) stay in
// perfect sync with what the dashboard is currently showing.
//
// Parity contract with AgentDashboard:
//   1. Uses only the built-in FALLBACK_PROJECTS (the 5 user-provided links),
//      NOT the live registry. This matches the dashboard's comment "Only the
//      5 user-provided source links are used on the dashboard".
//   2. Decorates every row with resolvePersonForRow() so name/email/dept match.
//   3. Honors the dashboard's persisted sessionStorage focus:
//        - agent:selected      → project drill-down
//        - agent:focus:person  → admin person filter
//        - agent:focus:dept    → admin dept filter
//   4. Applies the same name-scoping for non-admin users.

import { useEffect, useMemo, useState } from "react";
import { useQueries, keepPreviousData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fetchInsightUrl } from "@/lib/insights-proxy.functions";
import { FALLBACK_PROJECTS, type AgentProject } from "@/lib/agent-registry.functions";
import { useAgentScope, rowMatchesUser } from "@/hooks/useAgentScope";
import { useProfileDirectory } from "@/hooks/useProfileDirectory";
import { resolvePersonForRow } from "@/lib/person-resolver";
import type { Row } from "@/lib/entity-scope";

// Match AgentDashboard.AUTO_REFRESH_MS exactly so entity pages share the
// dashboard's query cache (same queryKey) and refresh on the same cadence.
const AUTO_REFRESH_MS = 2 * 60_000;

type SourcePayload = { connector?: string; department?: string; data?: Row[]; generated_at?: string };

// React to sessionStorage changes made by AgentDashboard in the same tab.
// Storage events only fire cross-tab, so the dashboard dispatches a custom
// event; we also poll on mount to pick up whatever it last persisted.
function useSessionValue(key: string, fallback: string): string {
  const [val, setVal] = useState<string>(() => {
    if (typeof window === "undefined") return fallback;
    return sessionStorage.getItem(key) ?? fallback;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const read = () => setVal(sessionStorage.getItem(key) ?? fallback);
    read();
    const onStorage = (e: StorageEvent) => { if (e.key === key) read(); };
    const onFocus = () => read();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(read, 1500);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      window.clearInterval(t);
    };
  }, [key, fallback]);
  return val;
}

export function useAgentSources() {
  const fetchUrl = useServerFn(fetchInsightUrl);
  const scope = useAgentScope();
  const { directory: profileDir } = useProfileDirectory();

  // Same source list the dashboard uses — no registry override.
  const allProjects: AgentProject[] = useMemo(() => FALLBACK_PROJECTS, []);

  // Same scope gating the dashboard applies.
  const projects: AgentProject[] = useMemo(() => {
    if (scope.mode === "all") return allProjects;
    if (!scope.allowedProjectKeys) return allProjects;
    return allProjects.filter((p) => scope.allowedProjectKeys!.has(p.id));
  }, [allProjects, scope.mode, scope.allowedProjectKeys]);

  const queries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["agent-src", p.id, p.url, p.tab ?? ""] as const,
      queryFn: async () => {
        const res = await fetchUrl({ data: { url: p.url, tab: p.tab } });
        return { project: p, payload: (res as { payload?: SourcePayload }).payload };
      },
      staleTime: 0,
      refetchInterval: AUTO_REFRESH_MS,
      refetchIntervalInBackground: true,
      refetchOnMount: "always" as const,
      refetchOnWindowFocus: "always" as const,
      placeholderData: keepPreviousData,
      retry: 2,
      enabled: !!p.url,
    })),
  });

  const rawSources = queries.map((q, i) => ({
    project: projects[i],
    payload: (q.data as { payload?: SourcePayload } | undefined)?.payload,
    isFetching: q.isFetching,
    isLoading: q.isLoading,
    isError: q.isError,
  }));

  // Same person-decoration the dashboard applies to every source row.
  const sources = useMemo(() => {
    const decorate = (row: Row): Row => {
      const r = resolvePersonForRow(row, profileDir);
      return {
        ...row,
        "Responsible Person": r.displayName,
        __personKey: r.key,
        __personDisplay: r.displayName,
        __personRaw: r.roleTitle
          || String(row["Responsible Person"] ?? row["Responsibility"] ?? row["approvers name"] ?? ""),
        __personEmail: r.email,
        __personSource: r.source,
        __personIsTitleFallback: r.isTitleFallback,
      };
    };
    return rawSources.map((s) => (
      s.payload?.data
        ? { ...s, payload: { ...s.payload, data: s.payload.data.map(decorate) } }
        : s
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(","), profileDir]);

  // Pick up the dashboard's persisted focus so detail pages reflect the
  // exact slice the user is looking at on /agent.
  const selected = useSessionValue("agent:selected", "all");
  const focusPerson = useSessionValue("agent:focus:person", "all");
  const focusDept = useSessionValue("agent:focus:dept", "all");
  const canFocus = scope.isAdmin;

  const rows: Row[] = useMemo(() => {
    const needles = scope.nameNeedles ?? [];
    const wantNameFilter = scope.mode === "name-scoped";
    const p = focusPerson.toLowerCase();
    const dep = focusDept.toLowerCase();

    const matchFocus = (r: Row): boolean => {
      if (!canFocus) return true;
      if (focusPerson !== "all") {
        const person = String(r["Responsible Person"] ?? r["Responsibility"] ?? r["approvers name"] ?? "").toLowerCase();
        const email = String(r["Responsible Person Mail ID"] ?? r["approvers email id"] ?? r["__personEmail"] ?? "").toLowerCase();
        if (person !== p && email !== p) return false;
      }
      if (focusDept !== "all") {
        const rowDept = String(r["Department"] ?? r["Vertical"] ?? r["Team"] ?? r["__department"] ?? "").toLowerCase();
        if (rowDept !== dep) return false;
      }
      return true;
    };

    const out: Row[] = [];
    for (const s of sources) {
      if (selected !== "all" && s.project.id !== selected) continue;
      const label = s.payload?.connector?.replace(" — view", "") || s.project.label;
      const dept = s.payload?.department;
      const data = s.payload?.data ?? [];
      for (const r of data) {
        if (wantNameFilter && needles.length && !rowMatchesUser(r, needles)) continue;
        const tagged = { ...r, __project: label, __department: dept };
        if (!matchFocus(tagged)) continue;
        out.push(tagged);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    queries.map((q) => q.dataUpdatedAt).join(","),
    scope.mode,
    scope.nameNeedles.join("|"),
    selected,
    focusPerson,
    focusDept,
    canFocus,
  ]);

  const anyLoading = queries.some((q) => q.isLoading);
  const anyFetching = queries.some((q) => q.isFetching);
  const refetchAll = () => { queries.forEach((q) => q.refetch()); };

  return {
    projects,
    allProjects,
    sources,
    rows,
    anyLoading,
    anyFetching,
    refetchAll,
    scope,
    // Surface the applied dashboard focus so pages can label themselves.
    focus: { selected, person: focusPerson, dept: focusDept },
  };
}
