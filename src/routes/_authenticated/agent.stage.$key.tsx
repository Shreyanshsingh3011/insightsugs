import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import { decodeKey, stageName, toScopedRow } from "@/lib/entity-scope";

export const Route = createFileRoute("/_authenticated/agent/stage/$key")({
  component: StagePage,
});

function StagePage() {
  const { key } = Route.useParams();
  const decoded = useMemo(() => { try { return decodeKey(key); } catch { return key; } }, [key]);

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();
  const needle = decoded.toLowerCase();

  const scoped = useMemo(() => rows
    .filter((r) => stageName(r).toLowerCase() === needle)
    .map((r, i) => toScopedRow(r, i)),
  [rows, needle]);

  const projects = new Set(scoped.map((r) => r.project));
  const people = new Set(scoped.map((r) => r.person).filter((p) => p && p !== "Unassigned"));

  return (
    <EntityDetailShell
      title={decoded}
      subtitle={`${projects.size} project(s) · ${people.size} owner(s)`}
      kindIcon="stage"
      rows={scoped}
      loading={anyLoading}
      refetching={anyFetching}
      onRefresh={refetchAll}
      actionContext={{
        scopeKind: "stage",
        scopeLabel: decoded,
        scopeRef: key,
        summaryLine: scoped.length
          ? `Stage covers ${scoped.length} activities across ${projects.size} project(s); ${scoped.filter((r) => r.delay > 0).length} delayed.`
          : undefined,
      }}
    />
  );
}
