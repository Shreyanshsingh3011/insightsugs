// Per-row detail page. Every dashboard row (overdue queue, filtered report,
// scoped entity tables) deep-links here via `encodeRowKey`. We rehydrate the
// row from the live source cache (same queries the dashboard uses) so the URL
// stays short and the data stays real-time.

import { useMemo } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft, RefreshCw, AlertTriangle, Clock, Gauge, User as UserIcon,
  Mail, Layers, FolderKanban, CheckCircle2, TrendingUp, Lightbulb,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAgentSources } from "@/hooks/useAgentSources";
import {
  decodeRowKey, rowMatchesIdent, personName, personEmail, stageName,
  activityName, statusText, num, encodeKey as encodeEntityKey, toScopedRow,
} from "@/lib/entity-scope";
import { EntityActionsBar } from "@/components/EntityActionsBar";
import { DetailBreadcrumbs } from "@/components/DetailBreadcrumbs";
import { DetailExportMenu } from "@/components/DetailExportMenu";

export const Route = createFileRoute("/_authenticated/agent/row/$key")({
  head: () => ({ meta: [{ title: "Activity detail — DelayLens" }] }),
  component: RowPage,
});

const TONE = {
  ok: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
  med: "text-amber-800 bg-amber-500/10 border-amber-500/30",
  high: "text-rose-700 bg-rose-500/10 border-rose-500/30",
  low: "text-slate-700 bg-slate-500/10 border-slate-500/30",
} as const;

function toneFor(delay: number, tat: number): keyof typeof TONE {
  if (delay > 30 || (tat > 0 && delay > tat)) return "high";
  if (delay > 0) return "med";
  return "ok";
}

function RowPage() {
  const { key } = Route.useParams();
  const nav = useNavigate();
  const ident = useMemo(() => decodeRowKey(key), [key]);
  const { rows, sources, anyLoading, anyFetching, refetchAll } = useAgentSources();
  const windowTimestamps = useMemo(
    () => sources.map((s) => s.payload?.generated_at).filter(Boolean) as string[],
    [sources],
  );
  const row = useMemo(
    () => rows.find(r => rowMatchesIdent(r, ident, String(r["__project"] ?? ""))) ?? null,
    [rows, ident],
  );

  if (!row) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 space-y-4">
        <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to dashboard
        </Link>
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <div className="text-sm text-muted-foreground">
              {anyLoading ? "Loading activity from live sources…" : "This activity could not be located in the current data."}
            </div>
            {!anyLoading && (
              <div className="text-xs text-muted-foreground">
                Project <span className="font-medium">{ident.project || "—"}</span> · Sr. No.{" "}
                <span className="font-medium">{ident.srNo || "—"}</span> · {ident.activity || "—"}
              </div>
            )}
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => refetchAll()}>
                <RefreshCw className={`h-4 w-4 ${anyFetching ? "animate-spin" : ""}`} /> Retry
              </Button>
              <Button size="sm" onClick={() => nav({ to: "/agent" })}>Back to dashboard</Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  const project = String(row["__project"] ?? ident.project ?? "—");
  const activity = activityName(row) || ident.activity || "(unnamed)";
  const person = personName(row) || "Unassigned";
  const email = personEmail(row);
  const stage = stageName(row) || "—";
  const status = statusText(row) || "—";
  const tat = num(row["TAT"]);
  const taken = num(row["Days Taken"]);
  const delay = num(row["Delay in Days"]) || Math.max(0, taken - tat);
  const criticality = String(row["Criticality"] ?? "—");
  const startDate = String(row["Start Date"] ?? row["Planned Start"] ?? "—");
  const hc1 = String(row["HC-1"] ?? row["HC1"] ?? "—");
  const reportingManager = String(row["Reporting Manager"] ?? row["Reporting To"] ?? "—");
  const verticalHead = String(row["Vertical Head"] ?? "—");
  const tone = toneFor(delay, tat);

  // Rule-based recommendation identical to AgentDetail's logic.
  let rec = "This activity is on track. Keep monitoring.";
  let recTone: keyof typeof TONE = "ok";
  if (delay > 30) {
    rec = `Escalate to ${reportingManager !== "—" ? reportingManager : "the reporting manager"} and commit a recovery date. ${delay}d past TAT of ${tat || "—"}d.`;
    recTone = "high";
  } else if (delay > 0) {
    rec = `Ping ${person} for a status commit today — currently ${delay}d late (TAT ${tat}d, taken ${taken}d).`;
    recTone = "med";
  } else if (tat > 0 && taken > 0.8 * tat && !/complete|done/i.test(status)) {
    rec = `Approaching TAT (${taken}/${tat}d). Confirm no blockers with ${person}.`;
    recTone = "med";
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 md:py-8 space-y-6">
      {/* Nav + breadcrumbs + export */}
      <div className="flex flex-wrap items-center gap-3">
        <DetailBreadcrumbs
          kind="row"
          title={activity}
          parent={{ label: project, to: "/agent/project/$projectId", params: { projectId: encodeEntityKey(project) } }}
        />
        <div className="ml-auto flex items-center gap-2">
          <DetailExportMenu
            rows={[toScopedRow(row, 0, project)]}
            totalInScope={1}
            ctx={{
              kind: "row",
              title: activity,
              subtitle: `${project} · ${status}`,
              windowTimestamps,
            }}
            ownerEmail={email || null}
          />
          <Button size="sm" variant="outline" onClick={() => refetchAll()}>
            <RefreshCw className={`h-4 w-4 ${anyFetching ? "animate-spin" : ""}`} /> Sync
          </Button>
        </div>
      </div>

      {/* Header */}
      <Card className="overflow-hidden border-slate-500/30 bg-gradient-to-br from-slate-500/[0.08] to-rose-500/[0.05]">
        <CardContent className="p-5 md:p-6">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-slate-500/10 text-slate-700">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Activity</div>
              <h1 className="mt-0.5 break-words text-xl font-semibold leading-tight md:text-2xl">{activity}</h1>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Link to="/agent/project/$projectId" params={{ projectId: encodeEntityKey(project) }}>
                  <Badge variant="outline" className="cursor-pointer hover:bg-muted/60">
                    <FolderKanban className="mr-1 h-3 w-3" /> {project}
                  </Badge>
                </Link>
                <Link to="/agent/stage/$key" params={{ key: encodeEntityKey(stage) }}>
                  <Badge variant="outline" className="cursor-pointer hover:bg-muted/60">
                    <Layers className="mr-1 h-3 w-3" /> {stage}
                  </Badge>
                </Link>
                <Badge variant="outline" className={
                  /complete|done/i.test(status) ? TONE.ok :
                  /delay|late|overdue/i.test(status) ? TONE.high :
                  /progress/i.test(status) ? TONE.med : TONE.low
                }>{status}</Badge>
                {criticality !== "—" && <Badge variant="secondary">{criticality}</Badge>}
                {ident.srNo && <Badge variant="secondary">Sr. No. {ident.srNo}</Badge>}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <EntityActionsBar
              ctx={{
                scopeKind: "stage",
                scopeLabel: activity,
                scopeRef: `row:${key}`,
                responsibleName: person,
                responsibleEmail: email || null,
                defaultDept: null,
                summaryLine: `${activity} · ${project} · ${status} · TAT ${tat || "—"}d, taken ${taken || "—"}d${delay > 0 ? `, ${delay}d late` : ""}.`,
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Metrics strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Activity metrics">
        <Kpi icon={<Clock className="h-4 w-4" />} label="TAT" value={tat ? `${tat}d` : "—"} tone="low" />
        <Kpi icon={<Gauge className="h-4 w-4" />} label="Days taken" value={taken ? `${taken}d` : "—"} tone={taken > tat && tat > 0 ? "high" : "ok"} />
        <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Delay" value={delay ? `${delay}d` : "0d"} tone={tone} />
        <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="Status" value={status} tone={
          /complete|done/i.test(status) ? "ok" : /delay|late|overdue/i.test(status) ? "high" : "med"
        } />
      </section>

      {/* Owner + recommendation */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <UserIcon className="h-4 w-4 text-indigo-500" /> Owner
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Responsible</span>
              <Link
                to="/agent/person/$key" params={{ key: encodeEntityKey(person) }}
                className="font-medium hover:underline"
              >{person}</Link>
            </div>
            {email && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Email</span>
                <a href={`mailto:${email}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                  <Mail className="h-3.5 w-3.5" />{email}
                </a>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Reporting Manager</span>
              <span className="font-medium">{reportingManager}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Vertical Head</span>
              <span className="font-medium">{verticalHead}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">HC-1</span>
              <span className="font-medium">{hc1}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Start Date</span>
              <span className="font-medium">{startDate}</span>
            </div>
          </CardContent>
        </Card>

        <Card className={`border ${TONE[recTone]}`}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Lightbulb className="h-4 w-4" /> Next best action
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">{rec}</p>
          </CardContent>
        </Card>
      </div>

      {/* Raw fields */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">All fields</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
            {Object.entries(row)
              .filter(([k]) => k !== "__project" && !k.startsWith("_"))
              .map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2 border-b border-border/40 py-1">
                  <span className="min-w-[130px] shrink-0 text-muted-foreground">{k}</span>
                  <span className="truncate font-medium" title={String(v ?? "")}>{String(v ?? "—")}</span>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function Kpi({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: string | number; tone: keyof typeof TONE;
}) {
  return (
    <Card className={`border ${TONE[tone]}`}>
      <CardContent className="p-3.5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest opacity-70">
          {icon}{label}
        </div>
        <div className="mt-1 text-lg font-semibold leading-tight tabular-nums truncate" title={String(value)}>{value}</div>
      </CardContent>
    </Card>
  );
}
