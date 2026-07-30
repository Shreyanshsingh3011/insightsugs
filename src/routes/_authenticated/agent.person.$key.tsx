/**
 * Route: "/_authenticated/agent/person/$key"
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
import {
  decodeKey, personEmail, personName, toScopedRow, pick, isPlaceholderLabel, type Row,
} from "@/lib/entity-scope";

import { isTerminalRow } from "@/lib/status-utils";

export const Route = createFileRoute("/_authenticated/agent/person/$key")({
  component: PersonPage,
});

/** Page component for "/_authenticated/agent/person/$key". */
function PersonPage() {
  const { key } = Route.useParams();
  const decoded = useMemo(() => {
    try { return decodeKey(key); } catch { return key; }
  }, [key]);

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();

  const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.]+/g, " ").trim();
  const needle = norm(decoded);
  const isEmail = needle.includes("@");
  // "Unassigned"/"\u2014" is a real bucket on the dashboard, so resolve it to the
  // rows that genuinely have no owner instead of rendering an empty page.
  const unassigned = isPlaceholderLabel(decoded);
  const scoped = useMemo(() => {
    // Match on the CANONICAL owner (toScopedRow → resolvePerson), the same field
    // the dashboard uses to build the link. Filtering raw sheet columns here made
    // this page disagree with the dashboard whenever the owner was resolved from
    // a fallback (responsibility column, profile lookup, role default).
    const all = rows.map((r, i) => toScopedRow(r, i, String(r["__project"] ?? "")));
    if (unassigned) return all.filter((r) => isPlaceholderLabel(r.person) && !r.email);
    const exact = all.filter((r) => norm(r.person) === needle || norm(r.email) === needle);
    if (exact.length) return exact;
    return all.filter((r) => {
      const n = norm(r.person);
      const e = norm(r.email);
      if (isEmail) return e.includes(needle);
      return Boolean(n) && (n.includes(needle) || needle.includes(n));
    });
  }, [rows, needle, isEmail, unassigned]);


  // Pick canonical display info from the first matching row.
  const first = scoped[0]?.row;
  const displayName = unassigned ? "Unassigned" : (first ? personName(first) || decoded : decoded);
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
      verificationTarget={{ kind: "person", label: decoded }}
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
