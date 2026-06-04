import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Bell, Flag, FileSearch, Search } from "lucide-react";
import { fetchDashboard, type DashboardData, type FlagEntry } from "@/lib/dashboard-data";
import { buildDashboardFromSheets } from "@/lib/dashboard.functions";

const SHEETS_KEY = "dashboard.selectedSheets.v1";

const searchSchema = z.object({
  id: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/alerts")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Alerts — DelayLens" },
      { name: "description", content: "Delay alerts with severity, stage, status and source." },
    ],
  }),
  component: AlertsPage,
});

function sevColor(sev?: string) {
  switch (sev) {
    case "Critical": return "bg-destructive/15 text-destructive";
    case "High": return "bg-orange-500/15 text-orange-600 dark:text-orange-400";
    case "Medium": return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400";
    default: return "bg-muted text-muted-foreground";
  }
}

function AlertsPage() {
  const { id } = Route.useSearch();
  const navigate = useNavigate({ from: "/alerts" });

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

  const [q, setQ] = useState("");
  const [fSev, setFSev] = useState<string>("all");
  const [fStatus, setFStatus] = useState<string>("all");

  const severities = useMemo(
    () => Array.from(new Set(allFlags.map((f) => f.severity).filter(Boolean))) as string[],
    [allFlags],
  );
  const statuses = useMemo(
    () => Array.from(new Set(allFlags.map((f) => f.status).filter(Boolean))) as string[],
    [allFlags],
  );

  const flags = useMemo(() => {
    return allFlags.filter((f) => {
      if (fSev !== "all" && f.severity !== fSev) return false;
      if (fStatus !== "all" && f.status !== fStatus) return false;
      if (q.trim()) {
        const hay = `${f.id} ${f.activity} ${f.flagged_to?.person ?? ""} ${f.reason_text ?? ""} ${f.reason ?? ""} ${f.stage ?? ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
  }, [allFlags, fSev, fStatus, q]);

  const selected = useMemo(() => (id ? allFlags.find((f) => f.id === id) ?? null : null), [id, allFlags]);
  const setSelected = (f: FlagEntry | null) => {
    navigate({ search: f ? { id: f.id } : {}, replace: true });
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-md bg-destructive/15 text-destructive">
          <Bell className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Alerts</h1>
          <p className="text-sm text-muted-foreground">
            Delay alerts across {dynamic ? `${selectedSheetIds.length} selected sheet${selectedSheetIds.length === 1 ? "" : "s"}` : "the demo dataset"}. Click a row for details.
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
                    onClick={() => setSelected(f)}
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

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flag className="h-4 w-4 text-destructive" />
              <span>{selected?.id} — Alert details</span>
            </DialogTitle>
          </DialogHeader>
          {selected && (() => {
            const owner = selected.flagged_to?.person;
            const reason = selected.reason_text?.trim() || selected.reason || "Not specified";
            const overrun = selected.tat && selected.days_taken ? Math.max(0, selected.days_taken - selected.tat) : (selected.overdue_days ?? 0);
            const overrunPct = selected.tat && selected.days_taken ? Math.round(((selected.days_taken - selected.tat) / selected.tat) * 100) : null;
            const rootCause =
              (selected.days_taken ?? 0) === 0 && (selected.overdue_days ?? 0) === 0
                ? `Activity not yet started — ${selected.stage ?? "stage"} pending action from ${owner ?? "owner"}.`
                : overrunPct !== null
                  ? `Took ${selected.days_taken}d vs ${selected.tat}d TAT — ${overrunPct}% overrun (${overrun}d late).`
                  : `${overrun}d overdue beyond planned TAT.`;
            return (
              <div className="space-y-4">
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-destructive">Root cause</p>
                  <p className="mt-1 text-sm">{rootCause}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Reason flagged:</span> {reason}
                  </p>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <Field label="Activity" value={selected.activity} />
                  <Field label="Responsible" value={owner ?? "—"} />
                  <Field label="Stage / Source" value={selected.stage ?? "—"} />
                  <Field label="Severity" value={selected.severity ?? "—"} />
                  <Field label="Status" value={selected.status ?? "—"} />
                  <Field label="Planned TAT" value={selected.tat != null ? `${selected.tat} days` : "—"} />
                  <Field label="Actual taken" value={selected.days_taken != null ? `${selected.days_taken} days` : "Not started"} />
                  <Field label="Overdue" value={`${selected.overdue_days ?? 0} days`} />
                  <Field label="Escalation" value={`Level ${selected.escalation_level ?? 0}`} />
                </div>

                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => setSelected(null)}>Close</Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm">{value}</p>
    </div>
  );
}
