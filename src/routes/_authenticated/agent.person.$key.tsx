import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import {
  decodeKey, personEmail, personName, toScopedRow, pick, type Row,
} from "@/lib/entity-scope";

import { isTerminalRow } from "@/lib/status-utils";

export const Route = createFileRoute("/_authenticated/agent/person/$key")({
  component: PersonPage,
});

function PersonPage() {
  const { key } = Route.useParams();
  const decoded = useMemo(() => {
    try { return decodeKey(key); } catch { return key; }
  }, [key]);

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();

  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, " ").trim();
  const needle = norm(decoded);
  const isEmail = needle.includes("@");
  const scoped = useMemo(() => {
    const match = (r: Row) => {
      const n = norm(personName(r));
      const e = norm(personEmail(r));
      if (isEmail) return e === needle || e.includes(needle);
      return n === needle || e === needle || (n && (n.includes(needle) || needle.includes(n)));
    };
    const exact = rows.filter((r) => norm(personName(r)) === needle || norm(personEmail(r)) === needle);
    const chosen = exact.length ? exact : rows.filter(match);
    return chosen.map((r, i) => toScopedRow(r, i));
  }, [rows, needle, isEmail]);


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
          ? `Owns ${scoped.length} activities across ${new Set(scoped.map((r) => r.project)).size} project(s); ${scoped.filter((r) => r.delay > 0 && !isTerminalRow(r.row)).length} currently delayed.`
          : undefined,
      }}
    />
  );
}
