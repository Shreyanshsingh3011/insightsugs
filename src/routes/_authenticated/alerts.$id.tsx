import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Flag, AlertTriangle, Clock, User, Building2, Mail, Phone, FileSearch, TrendingUp } from "lucide-react";
import { fetchDashboard, type DashboardData, type FlagEntry } from "@/lib/dashboard-data";
import { buildDashboardFromSheets } from "@/lib/dashboard.functions";

const SHEETS_KEY = "dashboard.selectedSheets.v1";

export const Route = createFileRoute("/_authenticated/alerts/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Alert ${params.id} — DelayLens` },
      { name: "description", content: "Full alert details, root cause and ownership." },
    ],
  }),
  component: AlertDetails,
});

function sevColor(sev?: string) {
  switch (sev) {
    case "Critical": return "bg-destructive/15 text-destructive border-destructive/30";
    case "High": return "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30";
    case "Medium": return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function AlertDetails() {
  const { id } = Route.useParams();
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

  const flag: FlagEntry | undefined = useMemo(
    () => data?.flags?.find((f) => f.id === id),
    [data, id],
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/alerts" })} className="-ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to alerts
        </Button>
        <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">
          View dashboard
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading alert…</p>}
      {error && <p className="text-sm text-destructive">Failed to load alert.</p>}

      {!isLoading && !flag && (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
          <AlertTriangle className="h-7 w-7" />
          <p className="text-sm">Alert <span className="font-mono">{id}</span> not found in the current dataset.</p>
          <Button size="sm" variant="outline" onClick={() => navigate({ to: "/alerts" })}>Back to list</Button>
        </Card>
      )}

      {flag && (() => {
        const owner = flag.flagged_to?.person;
        const email = flag.flagged_to?.email;
        const phone = flag.flagged_to?.phone;
        const reason = flag.reason_text?.trim() || flag.reason || "Not specified";
        const overrun = flag.tat && flag.days_taken ? Math.max(0, flag.days_taken - flag.tat) : (flag.overdue_days ?? 0);
        const overrunPct = flag.tat && flag.days_taken ? Math.round(((flag.days_taken - flag.tat) / flag.tat) * 100) : null;
        const rootCause =
          (flag.days_taken ?? 0) === 0 && (flag.overdue_days ?? 0) === 0
            ? `Activity not yet started — ${flag.stage ?? "stage"} pending action from ${owner ?? "owner"}.`
            : overrunPct !== null
              ? `Took ${flag.days_taken}d vs ${flag.tat}d TAT — ${overrunPct}% overrun (${overrun}d late).`
              : `${overrun}d overdue beyond planned TAT.`;

        return (
          <div className="space-y-5">
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Flag className="h-4 w-4 text-destructive" />
                    <span className="font-mono text-xs text-muted-foreground">{flag.id}</span>
                    <span className={`rounded-md border px-2 py-0.5 text-xs ${sevColor(flag.severity)}`}>
                      {flag.severity ?? "—"}
                    </span>
                    <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                      {flag.status ?? "—"}
                    </span>
                  </div>
                  <h1 className="mt-2 text-lg font-semibold tracking-tight">{flag.activity}</h1>
                  <p className="text-xs text-muted-foreground">
                    Stage: {flag.stage ?? "—"} · Type: {flag.type ?? "delay"} · Escalation L{flag.escalation_level ?? 0}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Overdue</p>
                  <p className="text-2xl font-semibold text-destructive">{flag.overdue_days ?? 0}d</p>
                </div>
              </div>
            </Card>

            <Card className="border-destructive/30 bg-destructive/5 p-5">
              <p className="text-[10px] uppercase tracking-wider text-destructive">Root cause</p>
              <p className="mt-1 text-sm">{rootCause}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Reason flagged:</span> {reason}
              </p>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card className="p-5">
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Ownership</p>
                <div className="space-y-2 text-sm">
                  <Row icon={<User className="h-3.5 w-3.5" />} label="Responsible" value={owner ?? "—"} />
                  <Row icon={<Mail className="h-3.5 w-3.5" />} label="Email" value={email ?? "—"} />
                  <Row icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={phone ?? "—"} />
                  <Row icon={<Building2 className="h-3.5 w-3.5" />} label="Stage / Source" value={flag.stage ?? "—"} />
                </div>
              </Card>

              <Card className="p-5">
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Timing</p>
                <div className="space-y-2 text-sm">
                  <Row icon={<Clock className="h-3.5 w-3.5" />} label="Planned TAT" value={flag.tat != null ? `${flag.tat} days` : "—"} />
                  <Row icon={<Clock className="h-3.5 w-3.5" />} label="Actual taken" value={flag.days_taken != null ? `${flag.days_taken} days` : "Not started"} />
                  <Row icon={<TrendingUp className="h-3.5 w-3.5" />} label="Overrun" value={overrunPct !== null ? `${overrunPct}% (${overrun}d)` : `${overrun}d`} />
                  <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Criticality" value={flag.criticality ?? "—"} />
                </div>
              </Card>
            </div>

            <Card className="p-5">
              <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <FileSearch className="h-3.5 w-3.5" /> Source context
              </p>
              <p className="text-sm text-muted-foreground">
                Sourced from {dynamic ? `${selectedSheetIds.length} selected sheet${selectedSheetIds.length === 1 ? "" : "s"}` : "the demo dataset"}.
                Stage label: <span className="text-foreground">{flag.stage ?? "sheet"}</span>.
              </p>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-2 last:border-0 last:pb-0">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}
