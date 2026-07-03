import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import {
  decodeKey, personEmail, personName, toScopedRow, pick,
} from "@/lib/entity-scope";

export const Route = createFileRoute("/_authenticated/agent/person/$key")({
  component: PersonPage,
});

function PersonPage() {
  const { key } = Route.useParams();
  const decoded = useMemo(() => {
    try { return decodeKey(key); } catch { return key; }
  }, [key]);

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();

  const needle = decoded.toLowerCase();
  const scoped = useMemo(() => {
    return rows
      .filter((r) => {
        const n = personName(r).toLowerCase();
        const e = personEmail(r).toLowerCase();
        return n === needle || e === needle || (needle.includes("@") ? e.includes(needle) : n.includes(needle));
      })
      .map((r, i) => toScopedRow(r, i));
  }, [rows, needle]);

  // Pick canonical display info from the first matching row.
  const first = scoped[0]?.row;
  const displayName = first ? personName(first) || decoded : decoded;
  const email = first ? personEmail(first) : (decoded.includes("@") ? decoded : "");
  const dept = first ? pick(first, "Department", "Vertical", "Team") : "";

  return (
    <EntityDetailShell
      title={displayName}
      subtitle={[email, dept, `${new Set(scoped.map((r) => r.project)).size} project(s)`].filter(Boolean).join(" · ")}
      kindIcon="person"
      rows={scoped}
      loading={anyLoading}
      refetching={anyFetching}
      onRefresh={refetchAll}
      actionContext={{
        scopeKind: "person",
        scopeLabel: displayName,
        scopeRef: key,
        responsibleName: displayName,
        responsibleEmail: email || null,
        defaultDept: dept || null,
        summaryLine: scoped.length
          ? `Owns ${scoped.length} activities across ${new Set(scoped.map((r) => r.project)).size} project(s); ${scoped.filter((r) => r.delay > 0).length} currently delayed.`
          : undefined,
      }}
    />
  );
}
