// Shared presentation shell for entity detail pages (person, stage, project).
// Renders a header, KPI strip, actions bar, scoped rows table with row-level
// deep-links into the existing /agent/detail/$payload page, and a compact
// scoped chatbot placeholder (the full grounded chat lives on the dashboard).

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft, RefreshCw, Layers, User as UserIcon, FolderKanban,
  AlertTriangle, Loader2, TrendingUp, Clock, CheckCircle2, Gauge,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { EntityActionsBar, type EntityActionContext } from "@/components/EntityActionsBar";
import { encodeDetailPayload } from "@/lib/agent-detail-payload";
import { summarize, type ScopedRow } from "@/lib/entity-scope";

export type EntityDetailShellProps = {
  title: string;
  subtitle?: string;
  kindIcon: "person" | "stage" | "project";
  rows: ScopedRow[];
  loading?: boolean;
  refetching?: boolean;
  onRefresh?: () => void;
  actionContext: EntityActionContext;
  extra?: React.ReactNode;
};

const TONE = {
  ok: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
  med: "text-amber-800 bg-amber-500/10 border-amber-500/30",
  high: "text-rose-700 bg-rose-500/10 border-rose-500/30",
  low: "text-slate-700 bg-slate-500/10 border-slate-500/30",
} as const;

function Icon({ kind }: { kind: "person" | "stage" | "project" }) {
  const C = kind === "person" ? UserIcon : kind === "stage" ? Layers : FolderKanban;
  return <C className="h-5 w-5" aria-hidden />;
}

export function EntityDetailShell({
  title, subtitle, kindIcon, rows, loading, refetching, onRefresh, actionContext, extra,
}: EntityDetailShellProps) {
  const s = useMemo(() => summarize(rows), [rows]);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return rows;
    const needle = q.toLowerCase();
    return rows.filter((r) =>
      [r.activity, r.person, r.stage, r.status, r.project, r.email].some((v) => v.toLowerCase().includes(needle)),
    );
  }, [rows, q]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:py-8 space-y-6">
      {/* Top nav */}
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to dashboard
        </Link>
        {onRefresh && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw className={`h-4 w-4 ${refetching ? "animate-spin" : ""}`} /> Sync
          </Button>
        )}
      </div>

      {/* Header */}
      <Card className="overflow-hidden border-primary/30 bg-gradient-to-br from-primary/[0.07] to-transparent">
        <CardContent className="p-5 md:p-6">
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
              <Icon kind={kindIcon} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{kindIcon}</div>
              <h1 className="mt-0.5 break-words text-xl font-semibold leading-tight md:text-2xl">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline">{s.n} activities</Badge>
                <Badge variant="outline" className={TONE.ok}>{s.done} done</Badge>
                <Badge variant="outline" className={s.delayed > 0 ? TONE.high : TONE.low}>{s.delayed} delayed</Badge>
                {actionContext.responsibleEmail && (
                  <Badge variant="secondary">{actionContext.responsibleEmail}</Badge>
                )}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <EntityActionsBar ctx={actionContext} />
          </div>
        </CardContent>
      </Card>

      {/* KPI strip */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Key metrics">
        <Kpi icon={<Gauge className="h-4 w-4" />} label="Health" value={s.healthScore}
             tone={s.healthScore > 70 ? "ok" : s.healthScore > 40 ? "med" : "high"} />
        <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="On-time" value={`${s.onTimePct}%`}
             tone={s.onTimePct > 80 ? "ok" : s.onTimePct > 50 ? "med" : "high"} />
        <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Completion" value={`${s.completionPct}%`}
             tone={s.completionPct > 70 ? "ok" : s.completionPct > 40 ? "med" : "high"} />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Avg delay" value={`${s.avgDelay}d`}
             tone={s.avgDelay > 30 ? "high" : s.avgDelay > 0 ? "med" : "ok"} />
      </section>

      {extra}

      {/* Activities */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-primary" /> Activities
            <Badge variant="secondary" className="ml-1">{filtered.length}</Badge>
            <Input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search activities…"
              className="ml-auto h-8 max-w-[220px] text-xs"
              aria-label="Search activities"
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading && rows.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            <div className="max-h-[520px] overflow-auto rounded-lg border border-border/60">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>Activity</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead>Person</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">TAT</TableHead>
                    <TableHead className="text-right">Taken</TableHead>
                    <TableHead className="text-right">Delay</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.slice(0, 200).map((r) => {
                    const payloadStr = encodeDetailPayload({
                      kind: "row",
                      projectLabel: r.project,
                      title: r.activity,
                      source: kindIcon === "person" ? "Person profile" : kindIcon === "stage" ? "Stage detail" : "Project workspace",
                      severity: r.delay > 30 ? "high" : r.delay > 0 ? "med" : "low",
                      person: r.person, stage: r.stage, email: r.email,
                      detail: `${r.status || "—"} · TAT ${r.tat}d / taken ${r.taken}d${r.delay > 0 ? ` · ${r.delay}d late` : ""}`,
                      row: r.row as Record<string, unknown>,
                    });
                    return (
                      <TableRow key={`${r.project}-${r.i}`} className="cursor-pointer hover:bg-muted/40">
                        <TableCell className="max-w-[260px] truncate font-medium" title={r.activity}>
                          <Link to="/agent/detail/$payload" params={{ payload: payloadStr }} className="hover:underline">
                            {r.activity}
                          </Link>
                        </TableCell>
                        <TableCell className="text-xs">{r.project}</TableCell>
                        <TableCell className="text-xs">{r.person}</TableCell>
                        <TableCell className="text-xs">{r.stage}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            /complete|done/i.test(r.status) ? TONE.ok :
                            /delay|late|overdue/i.test(r.status) ? TONE.high :
                            /progress/i.test(r.status) ? TONE.med : TONE.low
                          }>{r.status || "—"}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{r.tat || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.taken || "—"}</TableCell>
                        <TableCell className={`text-right tabular-nums ${r.delay > 0 ? "text-rose-600 font-semibold" : ""}`}>{r.delay || "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {filtered.length > 200 && (
                <p className="p-2 text-[11px] text-muted-foreground">Showing first 200 of {filtered.length}.</p>
              )}
            </div>
          )}
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
        <div className="mt-1 text-2xl font-semibold leading-none tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}
