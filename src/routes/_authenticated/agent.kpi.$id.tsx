import { useMemo } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import { toScopedRow, type ScopedRow } from "@/lib/entity-scope";
import { isTerminalRow } from "@/lib/status-utils";

type KpiId = "health" | "ontime" | "overdue" | "tat" | "risk";
const KPI_META: Record<KpiId, {
  title: string; rule: string; tone: "ok" | "med" | "high" | "low";
  filter: (r: ScopedRow) => boolean;
  sort?: (a: ScopedRow, b: ScopedRow) => number;
}> = {
  health: {
    title: "Project health",
    rule: "Every activity in scope, sorted by delay (biggest drags first).",
    tone: "med",
    filter: () => true,
    sort: (a, b) => b.delay - a.delay,
  },
  ontime: {
    title: "On-time completions",
    rule: "Completed activities whose delay ≤ 0.",
    tone: "ok",
    filter: (r) => isTerminalRow(r.row) && r.delay <= 0,
  },
  overdue: {
    title: "Overdue activities",
    rule: "Not complete AND delay > 0.",
    tone: "high",
    filter: (r) => !isTerminalRow(r.row) && r.delay > 0,
    sort: (a, b) => b.delay - a.delay,
  },
  tat: {
    title: "TAT breaches",
    rule: "Days taken exceeds the TAT budget.",
    tone: "med",
    filter: (r) => !isTerminalRow(r.row) && r.tat > 0 && r.taken > r.tat,
    sort: (a, b) => (b.taken - b.tat) - (a.taken - a.tat),
  },
  risk: {
    title: "High-risk activities",
    rule: "Delay > 30 days, or delayed AND high criticality.",
    tone: "high",
    filter: (r) => !isTerminalRow(r.row) && (r.delay > 30 || (r.delay > 0 && /critical|high/i.test(String(r.row["Criticality"] ?? "")))),
    sort: (a, b) => b.delay - a.delay,
  },
};

export const Route = createFileRoute("/_authenticated/agent/kpi/$id")({
  component: KpiPage,
});

function KpiPage() {
  const { id } = Route.useParams();
  const meta = KPI_META[id as KpiId];
  if (!meta) throw notFound();

  const { rows, anyLoading, anyFetching, refetchAll } = useAgentSources();

  const scoped = useMemo(() => {
    const all = rows.map((r, i) => toScopedRow(r, i));
    const filtered = all.filter(meta.filter);
    if (meta.sort) filtered.sort(meta.sort);
    return filtered;
  }, [rows, meta]);

  // Top owner in this bucket becomes the default recipient for actions.
  const ownerCounts = new Map<string, { name: string; email: string; n: number }>();
  for (const r of scoped) {
    if (!r.person || r.person === "Unassigned") continue;
    const key = r.person;
    const cur = ownerCounts.get(key) ?? { name: r.person, email: r.email, n: 0 };
    cur.n++; if (!cur.email && r.email) cur.email = r.email;
    ownerCounts.set(key, cur);
  }
  const topOwner = [...ownerCounts.values()].sort((a, b) => b.n - a.n)[0];

  return (
    <EntityDetailShell
      title={meta.title}
      subtitle={`${scoped.length} matching activities · Rule: ${meta.rule}`}
      kindIcon="kpi"
      tone={meta.tone}
      rows={scoped}
      loading={anyLoading}
      refetching={anyFetching}
      onRefresh={refetchAll}
      actionContext={{
        scopeKind: "project",
        scopeLabel: meta.title,
        scopeRef: `kpi:${id}`,
        responsibleName: topOwner?.name ?? null,
        responsibleEmail: topOwner?.email || null,
        defaultDept: null,
        summaryLine: scoped.length
          ? `${scoped.length} activities match "${meta.title}"${topOwner ? `; top owner ${topOwner.name} (${topOwner.n})` : ""}.`
          : undefined,
      }}
    />
  );
}
