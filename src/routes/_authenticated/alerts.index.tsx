import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Bell, FileSearch, Search, UserCheck } from "lucide-react";
import { fetchDashboard, type DashboardData } from "@/lib/dashboard-data";
import { buildDashboardFromSheets } from "@/lib/dashboard.functions";
import { useAgentScope } from "@/hooks/useAgentScope";

const SHEETS_KEY = "dashboard.selectedSheets.v1";

export const Route = createFileRoute("/_authenticated/alerts/")({
  head: () => ({
    meta: [
      { title: "Alerts — DelayLens" },
      { name: "description", content: "Delay alerts with severity, stage, status and source." },
    ],
  }),
  component: AlertsList,
});

function sevColor(sev?: string) {
  switch (sev) {
    case "Critical": return "bg-destructive/15 text-destructive";
    case "High": return "bg-orange-500/15 text-orange-600 dark:text-orange-400";
    case "Medium": return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
    default: return "bg-muted text-muted-foreground";
  }
}

function AlertsList() {
  const navigate = useNavigate();

  const [selectedSheetIds, setSelectedSheetIds] = useState<string[]>([]);
  useEffect(() => {
    try { const s = localStorage.getItem(SHEETS_KEY); if (s) setSelectedSheetIds(JSON.parse(s)); } catch {}
  }, []);

  const buildFn = useServerFn(buildDashboardFromSheets);
  const dynamic = selectedSheetIds.length > 0;
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: dynamic ? ["alerts", "dynamic", ...selectedSheetIds] : ["alerts", "static"],
    queryFn: () => dynamic ? buildFn({ data: { sheetIds: selectedSheetIds } }) : fetchDashboard(),
  });

  const allFlags = data?.flags ?? [];
  const scope = useAgentScope();
  const [q, setQ] = useState("");
  const [fSev, setFSev] = useState<string>("all");
  const [fStatus, setFStatus] = useState<string>("all");
  const [onlyMine, setOnlyMine] = useState<boolean>(scope.mode === "name-scoped");
  useEffect(() => {
    // Default non-admins to "For me" once scope loads
    if (!scope.loading && scope.mode === "name-scoped") setOnlyMine(true);
  }, [scope.loading, scope.mode]);

  const severities = useMemo(
    () => Array.from(new Set(allFlags.map((f) => f.severity).filter(Boolean))) as string[],
    [allFlags],
  );
  const statuses = useMemo(
    () => Array.from(new Set(allFlags.map((f) => f.status).filter(Boolean))) as string[],
    [allFlags],
  );

  const flags = useMemo(() => {
    const needles = scope.nameNeedles;
    return allFlags.filter((f) => {
      if (fSev !== "all" && f.severity !== fSev) return false;
      if (fStatus !== "all" && f.status !== fStatus) return false;
      if (onlyMine && needles.length > 0) {
        const hay = `${f.flagged_to?.person ?? ""} ${f.flagged_to?.email ?? ""} ${f.activity ?? ""}`.toLowerCase();
        if (!needles.some((n) => hay.includes(n))) return false;
      }
      if (q.trim()) {
        const hay = `${f.id} ${f.activity} ${f.flagged_to?.person ?? ""} ${f.reason_text ?? ""} ${f.reason ?? ""} ${f.stage ?? ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [allFlags, fSev, fStatus, q, onlyMine, scope.nameNeedles]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Bell className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
          <p className="text-sm text-muted-foreground">
            Delay alerts across {dynamic ? `${selectedSheetIds.length} selected sheet${selectedSheetIds.length === 1 ? "" : "s"}` : "the demo dataset"}. Click a row for full details.
          </p>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search activity, owner, reason…"
              className="h-9 w-64 pl-8"
            />
          </div>
          <select
            value={fSev}
            onChange={(e) => setFSev(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All severities</option>
            {severities.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            value={fStatus}
            onChange={(e) => setFStatus(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="all">All statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-xs">
            <input
              type="checkbox"
              checked={onlyMine}
              onChange={(e) => setOnlyMine(e.target.checked)}
              disabled={scope.nameNeedles.length === 0}
              aria-label="Show only alerts for me"
            />
            <UserCheck className="h-3.5 w-3.5" /> For me
          </label>
          <div className="ml-auto text-xs text-muted-foreground">
            {flags.length} of {allFlags.length} alert{allFlags.length === 1 ? "" : "s"}
          </div>
        </div>

        {isLoading && <p className="mt-4 text-sm text-muted-foreground">Loading alerts…</p>}
        {error && <p className="mt-4 text-sm text-destructive">Failed to load alerts.</p>}
        {!isLoading && !flags.length && (
          <div className="mt-6 flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
            <AlertTriangle className="h-6 w-6" />
            <p className="text-sm">No alerts match the current filters.</p>
          </div>
        )}

        {!!flags.length && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-4">ID</th>
                  <th className="py-2 pr-4">Activity</th>
                  <th className="py-2 pr-4">Owner</th>
                  <th className="py-2 pr-4">Stage</th>
                  <th className="py-2 pr-4">Overdue</th>
                  <th className="py-2 pr-4">Severity</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Source</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((f) => (
                  <tr
                    key={f.id}
                    onClick={() => navigate({ to: "/alerts/$id", params: { id: f.id } })}
                    className="cursor-pointer border-b border-border/40 transition-colors last:border-0 hover:bg-accent/40"
                  >
                    <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{f.id}</td>
                    <td className="max-w-xs truncate py-3 pr-4">{f.activity}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{f.flagged_to?.person ?? "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{f.stage ?? "—"}</td>
                    <td className="py-3 pr-4">{f.overdue_days ?? 0}d</td>
                    <td className="py-3 pr-4">
                      <span className={`rounded-md px-2 py-0.5 text-xs ${sevColor(f.severity)}`}>{f.severity ?? "—"}</span>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{f.status ?? "—"}</td>
                    <td className="py-3">
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <FileSearch className="h-3.5 w-3.5" /> {f.stage ?? "sheet"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
