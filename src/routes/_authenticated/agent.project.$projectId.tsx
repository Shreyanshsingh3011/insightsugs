/**
 * Route: "/_authenticated/agent/project/$projectId"
 * Access: any authenticated user with at least one role (see _authenticated.tsx).
 * Purpose: rendered inside the "_authenticated" layout (sidebar/header shell).
 * Data dependencies: Data fetched via shared hooks/components used within the page (see imports).
 * Gotchas: this is a client-rendered SPA route (no server loader) — data is fetched on mount
 * via React Query/hooks, not via a TanStack Router `loader`.
 */
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { RowQualitySummary } from "@/components/RowQualitySummary";
import { useAgentSources } from "@/hooks/useAgentSources";
import { decodeKey, toScopedRow } from "@/lib/entity-scope";
import { isTerminalRow } from "@/lib/status-utils";

export const Route = createFileRoute("/_authenticated/agent/project/$projectId")({
  component: ProjectPage,
});

/** Page component for "/_authenticated/agent/project/$projectId". */
function ProjectPage() {
  const { projectId } = Route.useParams();
  const { projects, sources, rows, anyLoading, anyFetching, refetchAll } = useAgentSources();
  const decodedProjectId = useMemo(() => {
    try { return decodeKey(projectId); } catch { return projectId; }
  }, [projectId]);

  const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[\s\-_/.,;:()]+/g, " ").trim();
  const needle = norm(decodedProjectId);
  const project =
    projects.find((p) => p.id === projectId) ||
    projects.find((p) => p.label === decodedProjectId) ||
    projects.find((p) => norm(p.id) === needle || norm(p.label) === needle) ||
    projects.find((p) => {
      const a = norm(p.label), b = norm(p.id);
      return (a && (a.includes(needle) || needle.includes(a))) || (b && (b.includes(needle) || needle.includes(b)));
    });
  const src =
    sources.find((s) => s.project.id === (project?.id ?? projectId)) ||
    sources.find((s) => norm(s.project.label) === needle) ||
    sources.find((s) => {
      const a = norm(s.project.label);
      return a && (a.includes(needle) || needle.includes(a));
    });
  // Use canonical project label (e.g. "Himachal") — the connector string is
  // often generic ("Google Sheet — public CSV") and breaks row-key matching.
  const label = project?.label || decodedProjectId;
  const dept = src?.payload?.department;

  const scoped = useMemo(() => {
    const wanted = norm(label);
    return rows
      .filter((r) => {
        const actual = norm(String(r["__project"] ?? ""));
        return actual === wanted || (actual && wanted && (actual.includes(wanted) || wanted.includes(actual)));
      })
      .map((r, i) => toScopedRow(r, i, label));
  }, [rows, label]);

  const people = new Set(scoped.map((r) => r.person).filter((p) => p && p !== "Unassigned"));

  const rawRows = scoped.map((r) => r.row);

  return (
    <div className="space-y-3">
      {rawRows.length > 0 && <RowQualitySummary rows={rawRows} label="Rows in this project" />}
      <EntityDetailShell
        title={label}
        subtitle={[dept, `${scoped.length} activities`, `${people.size} owners`].filter(Boolean).join(" · ")}
        kindIcon="project"
        rows={scoped}
        loading={anyLoading}
        refetching={anyFetching}
        onRefresh={refetchAll}
        verificationTarget={{ kind: "project", label }}
        actionContext={{
          scopeKind: "project",
          scopeLabel: label,
          scopeRef: decodedProjectId,
          defaultDept: dept ?? null,
          summaryLine: scoped.length
            ? `Project has ${scoped.length} activities; ${scoped.filter((r) => r.delay > 0 && !isTerminalRow(r.row)).length} delayed and ${scoped.filter((r) => isTerminalRow(r.row)).length} completed.`
            : undefined,
        }}
      />
    </div>
  );
}
