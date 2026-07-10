// Shared hook: fetches all agent-registry projects (with fallback), returns
// live source payloads scoped for the current user, and a flat list of rows
// tagged with their project label. Mirrors AgentDashboard's fetching setup so
// the entity detail pages stay in sync automatically.

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fetchInsightUrl } from "@/lib/insights-proxy.functions";
import { fetchAgentProjects, type AgentProject } from "@/lib/agent-registry.functions";
import { useAgentScope, rowMatchesUser } from "@/hooks/useAgentScope";
import type { Row } from "@/lib/entity-scope";

// Kept in sync with AgentDashboard.FALLBACK_PROJECTS.
const FALLBACK_PROJECTS: AgentProject[] = [
  { id: "nit58", label: "NIT-58",   url: "https://sheet2api-bypassed-login.vercel.app/api/public/a02c5f0800319fabb6d0679ec385de83" },
  { id: "bihar", label: "Bihar",    url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=1685983370#gid=1685983370" },
  { id: "hp",    label: "Himachal", url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=1063989895#gid=1063989895" },
  { id: "pspcl", label: "PSPCL",    url: "https://docs.google.com/spreadsheets/d/1ZQ56Y0nWMO28RQnWB1nQrjqNfFUuh8tIPw2k48eXEzQ/edit?gid=318275095#gid=318275095" },
  { id: "nit76", label: "NIT-76",   url: "https://sheet2api-bypassed-login.vercel.app/api/public/f81e454c36f9c0c609d103ba99e950b4" },
];
const AUTO_REFRESH_MS = 5 * 60_000;
const REGISTRY_REFRESH_MS = 5 * 60_000;

type SourcePayload = { connector?: string; department?: string; data?: Row[]; generated_at?: string };

export function useAgentSources() {
  const fetchUrl = useServerFn(fetchInsightUrl);
  const fetchRegistry = useServerFn(fetchAgentProjects);
  const scope = useAgentScope();

  const registryQ = useQuery({
    queryKey: ["agent-registry"],
    queryFn: () => fetchRegistry(),
    staleTime: REGISTRY_REFRESH_MS,
    refetchInterval: REGISTRY_REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const allProjects: AgentProject[] = useMemo(() => {
    const live = registryQ.data?.projects;
    return live && live.length ? live : FALLBACK_PROJECTS;
  }, [registryQ.data]);

  // Only projects the current user is allowed to see (super admins see all).
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
      staleTime: AUTO_REFRESH_MS,
      refetchInterval: AUTO_REFRESH_MS,
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: true,
    })),
  });

  const sources = queries.map((q, i) => ({
    project: projects[i],
    payload: (q.data as { payload?: SourcePayload } | undefined)?.payload,
    isFetching: q.isFetching,
    isLoading: q.isLoading,
    isError: q.isError,
  }));

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const needles = scope.nameNeedles ?? [];
    const wantNameFilter = scope.mode === "name-scoped";
    for (const s of sources) {
      const label = s.payload?.connector?.replace(" — view", "") || s.project.label;
      const data = s.payload?.data ?? [];
      for (const r of data) {
        if (wantNameFilter && needles.length && !rowMatchesUser(r, needles)) continue;
        out.push({ ...r, __project: label });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queries.map((q) => q.dataUpdatedAt).join(","), scope.mode, scope.nameNeedles.join("|")]);

  const anyLoading = queries.some((q) => q.isLoading);
  const anyFetching = queries.some((q) => q.isFetching);
  const refetchAll = () => { registryQ.refetch(); queries.forEach((q) => q.refetch()); };

  return { projects, allProjects, sources, rows, anyLoading, anyFetching, refetchAll, scope };
}
