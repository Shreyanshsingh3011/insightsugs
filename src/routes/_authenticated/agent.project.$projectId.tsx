import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import { toScopedRow } from "@/lib/entity-scope";

export const Route = createFileRoute("/_authenticated/agent/project/$projectId")({
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const { projects, sources, anyLoading, anyFetching, refetchAll } = useAgentSources();

  const project = projects.find((p) => p.id === projectId);
  const src = sources.find((s) => s.project.id === projectId);
  const label = src?.payload?.connector?.replace(" — view", "") || project?.label || projectId;
  const dept = src?.payload?.department;

  const scoped = useMemo(() => {
    const data = src?.payload?.data ?? [];
    return data.map((r, i) => toScopedRow({ ...r, __project: label }, i));
  }, [src?.payload?.data, label]);

  const people = new Set(scoped.map((r) => r.person).filter((p) => p && p !== "Unassigned"));

  return (
    <EntityDetailShell
      title={label}
      subtitle={[dept, `${scoped.length} activities`, `${people.size} owners`].filter(Boolean).join(" · ")}
      kindIcon="project"
      rows={scoped}
      loading={anyLoading}
      refetching={anyFetching}
      onRefresh={refetchAll}
      actionContext={{
        scopeKind: "project",
        scopeLabel: label,
        scopeRef: projectId,
        defaultDept: dept ?? null,
        summaryLine: scoped.length
          ? `Project has ${scoped.length} activities; ${scoped.filter((r) => r.delay > 0).length} delayed and ${scoped.filter((r) => /complete|done/i.test(r.status)).length} completed.`
          : undefined,
      }}
    />
  );
}
