/**
 * Route: "/_authenticated/agent/kpi/$id"
 * Access: any authenticated user with at least one role (see _authenticated.tsx).
 * Purpose: rendered inside the "_authenticated" layout (sidebar/header shell).
 * Data dependencies: Data fetched via shared hooks/components used within the page (see imports).
 * Gotchas: this is a client-rendered SPA route (no server loader) — data is fetched on mount
 * via React Query/hooks, not via a TanStack Router `loader`.
 */
import { useMemo } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { EntityDetailShell } from "@/components/EntityDetailShell";
import { useAgentSources } from "@/hooks/useAgentSources";
import { toScopedRow, type ScopedRow } from "@/lib/entity-scope";
import { isRowEffectivelyDone, statusBucketForRow } from "@/lib/status-utils";

type KpiId = "health" | "completed" | "ontime" | "delayed" | "overdue" | "tat" | "risk" | "remaining" | "notstarted";
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
    rule: "Completed activities (including finished-within-TAT) whose delay ≤ 0.",
    tone: "ok",
    filter: (r) => isRowEffectivelyDone(r.row) && r.delay <= 0,
  },
  completed: {
    title: "Completed activities",
    rule: "Every activity that is effectively complete, including rows completed by dates or terminal status.",
    tone: "ok",
    filter: (r) => isRowEffectivelyDone(r.row),
  },
  delayed: {
    title: "Delayed activities",
    rule: "Not effectively complete AND delayed by explicit delay, delayed status, or Days Taken exceeding TAT.",
    tone: "high",
    filter: (r) => !isRowEffectivelyDone(r.row) && (r.delay > 0 || statusBucketForRow(r.row) === "Delayed" || (r.tat > 0 && r.taken > r.tat)),
    sort: (a, b) => b.delay - a.delay,
  },
  overdue: {
    title: "Overdue activities",
    rule: "Not effectively complete AND delay > 0.",
    tone: "high",
    filter: (r) => !isRowEffectivelyDone(r.row) && r.delay > 0,
    sort: (a, b) => b.delay - a.delay,
  },
  tat: {
    title: "TAT breaches",
    rule: "Not effectively complete AND days taken exceeds the TAT budget.",
    tone: "med",
    filter: (r) => !isRowEffectivelyDone(r.row) && r.tat > 0 && r.taken > r.tat,
    sort: (a, b) => (b.taken - b.tat) - (a.taken - a.tat),
  },
  risk: {
    title: "High-risk activities",
    rule: "Not effectively complete AND (delay > 30 days, or delayed AND high criticality).",
    tone: "high",
    filter: (r) => !isRowEffectivelyDone(r.row) && (r.delay > 30 || (r.delay > 0 && /critical|high/i.test(String(r.row["Criticality"] ?? "")))),
    sort: (a, b) => b.delay - a.delay,
  },
  remaining: {
    title: "Remaining activities",
    rule: "Every activity not yet effectively complete; this is the row set behind the ETA projection.",
    tone: "med",
    filter: (r) => !isRowEffectivelyDone(r.row),
    sort: (a, b) => b.delay - a.delay,
  },
  notstarted: {
    title: "Not-started activities",
    rule: "Not effectively complete AND status bucket is Not Started.",
    tone: "low",
    filter: (r) => !isRowEffectivelyDone(r.row) && (statusBucketForRow(r.row) === "Not Started" || /not\s*started/i.test(r.status)),
  },
};

export const Route = createFileRoute("/_authenticated/agent/kpi/$id")({
  component: KpiPage,
});

/** Page component for "/_authenticated/agent/kpi/$id". */
function KpiPage() {
  const { id } = Route.useParams();
  const meta = KPI_META[id as KpiId];
  if (!meta) throw notFound();

  const { rows, anyLoading, anyFetching, refetchAll, focus, projects } = useAgentSources();

  const scoped = useMemo(() => {
    const all = rows.map((r, i) => toScopedRow(r, i));
    const filtered = all.filter(meta.filter);
    if (meta.sort) filtered.sort(meta.sort);
    return filtered;
  }, [rows, meta]);

  const focusBits: string[] = [];
  if (focus?.selected && focus.selected !== "all") {
    const proj = projects.find((p) => p.id === focus.selected);
    focusBits.push(`Project: ${proj?.label ?? focus.selected}`);
  }
  if (focus?.person && focus.person !== "all") focusBits.push(`Person: ${focus.person}`);
  if (focus?.dept && focus.dept !== "all") focusBits.push(`Dept: ${focus.dept}`);
  const focusLabel = focusBits.length ? ` · ${focusBits.join(" · ")}` : "";

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
      subtitle={`${scoped.length} matching activities · Rule: ${meta.rule}${focusLabel}`}
      kindIcon="kpi"
      tone={meta.tone}
      rows={scoped}
      loading={anyLoading}
      refetching={anyFetching}
      onRefresh={refetchAll}
      verificationTarget={{ kind: "kpi", id: id as KpiId }}
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
