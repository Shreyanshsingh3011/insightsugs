/**
 * Route: "/_authenticated/agent/stage/$key"
 * Access: any authenticated user with at least one role (see _authenticated.tsx).
 * Purpose: rendered inside the "_authenticated" layout (sidebar/header shell).
 * Data dependencies: Data fetched via shared hooks/components used within the page (see imports).
 * Gotchas: this is a client-rendered SPA route (no server loader) — data is fetched on mount
 * via React Query/hooks, not via a TanStack Router `loader`.
 */
import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import { decodeKey, stageName, toScopedRow } from "@/lib/entity-scope";
import { isTerminalRow } from "@/lib/status-utils";

export const Route = createFileRoute("/_authenticated/agent/stage/$key")({
  component: StagePage,
});

/** Page component for "/_authenticated/agent/stage/$key". */
function StagePage() {
  const { key } = Route.useParams();
  const decoded = useMemo(() => { try { return decodeKey(key); } catch { return key; } }, [key]);

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_/]+/g, " ").trim();
  const needle = norm(decoded);

  const scoped = useMemo(() => {
    const exact = rows.filter((r) => norm(stageName(r)) === needle);
    const matched = exact.length
      ? exact
      : rows.filter((r) => {
          const n = norm(stageName(r));
          return n && (n.includes(needle) || needle.includes(n));
        });
    return matched.map((r, i) => toScopedRow(r, i));
  }, [rows, needle]);



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
          ? `Stage covers ${scoped.length} activities across ${projects.size} project(s); ${scoped.filter((r) => r.delay > 0 && !isTerminalRow(r.row)).length} delayed.`
          : undefined,
      }}
    />
  );
}
