import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fetchInsightUrl } from "@/lib/insights-proxy.functions";
import { fetchSheetRows } from "@/lib/gsheets-agent.functions";
import { generateGeminiFn } from "@/lib/gemini.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  Sparkles, RefreshCw, AlertTriangle, TrendingUp, Users, Activity,
  Target, Zap, CheckCircle2, Clock, Loader2, Link2, Sheet as SheetIcon,
} from "lucide-react";

const DEFAULT_URL =
  "https://delaybridgesugs.vercel.app/api/public/PeuOiqTX8Suly1enDV4X68reUe6zkBrh/export?fields=summary,totals,risk_score,status_breakdown,sheets,flags,forecast,anomalies,digest,recommendations,trends,top_delay_reasons,dependency_chains,person_ranking,correlation_matrix,department_ranking,timeline_correlation,tat_performance";
const DEFAULT_SHEET =
  "https://docs.google.com/spreadsheets/d/1U2CkhrRBSv6VLbri_ROwhqCvXJvOKbqbWzJDrc4q-DQ/edit?gid=2069956310#gid=2069956310";

type Row = Record<string, string>;
type Payload = {
  project?: string;
  sheet?: string;
  sheet_type?: string;
  columns?: string[];
  count?: number;
  type_kpis?: { label: string; value: number }[];
  data?: Row[];
};

const SEV = {
  high: "text-rose-600 bg-rose-500/10 border-rose-500/30",
  medium: "text-amber-600 bg-amber-500/10 border-amber-500/30",
  low: "text-slate-600 bg-slate-500/10 border-slate-500/30",
  ok: "text-emerald-600 bg-emerald-500/10 border-emerald-500/30",
};
const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#64748b"];

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function bucket(status: string): "Completed" | "In Progress" | "Delayed" | "Not Started" | "Other" {
  const s = (status || "").toLowerCase();
  if (/complete/.test(s)) return "Completed";
  if (/progress/.test(s)) return "In Progress";
  if (/delay|overdue|late|breach/.test(s)) return "Delayed";
  if (/not start|yet/.test(s)) return "Not Started";
  return "Other";
}

function derive(payload: Payload | undefined) {
  const rows = payload?.data ?? [];
  const n = rows.length;
  const status: Record<string, number> = {};
  const stageAgg: Record<string, { total: number; delayed: number; delayDays: number }> = {};
  const personAgg: Record<string, { total: number; delayed: number; delayDays: number; completed: number; email?: string }> = {};
  const critAgg: Record<string, number> = {};
  const processAgg: Record<string, { total: number; delayed: number; delayDays: number }> = {};
  let totalDelay = 0;
  let delayedCount = 0;
  let overdueCount = 0;
  let completedCount = 0;
  const overdue: { activity: string; person: string; stage: string; delay: number; tat: number; taken: number; status: string; criticality: string }[] = [];

  for (const r of rows) {
    const st = bucket(r["Status Category"] || r["Status as on Date"] || "");
    status[st] = (status[st] || 0) + 1;
    const stage = r["Stages"] || "—";
    const person = r["Responsible Person"] || "Unassigned";
    const crit = r["Criticality"] || "—";
    const process = r["Process"] || "—";
    const delay = num(r["Delay in Days"]);
    const tat = num(r["TAT"]);
    const taken = num(r["Days Taken"]);

    critAgg[crit] = (critAgg[crit] || 0) + 1;
    stageAgg[stage] ??= { total: 0, delayed: 0, delayDays: 0 };
    stageAgg[stage].total++;
    processAgg[process] ??= { total: 0, delayed: 0, delayDays: 0 };
    processAgg[process].total++;
    personAgg[person] ??= { total: 0, delayed: 0, delayDays: 0, completed: 0, email: r["Responsible Person Mail ID"] };
    personAgg[person].total++;

    const isDelayed = st === "Delayed" || (st !== "Completed" && taken > tat && tat > 0);
    if (st === "Completed") { completedCount++; personAgg[person].completed++; }
    if (isDelayed) {
      delayedCount++;
      personAgg[person].delayed++;
      stageAgg[stage].delayed++;
      processAgg[process].delayed++;
      personAgg[person].delayDays += delay;
      stageAgg[stage].delayDays += delay;
      processAgg[process].delayDays += delay;
      totalDelay += delay;
    }
    if (st !== "Completed" && delay > 0) overdueCount++;
    if (st !== "Completed" && (delay > 0 || (tat > 0 && taken > tat))) {
      overdue.push({
        activity: r["Activity List"] || r["Process"] || "(unnamed)",
        person, stage, delay, tat, taken,
        status: r["Status Category"] || "",
        criticality: crit,
      });
    }
  }

  const persons = Object.entries(personAgg)
    .filter(([k]) => k && k !== "Unassigned")
    .map(([person, v]) => ({
      person,
      email: v.email || "",
      total: v.total,
      delayed: v.delayed,
      completed: v.completed,
      delayDays: v.delayDays,
      efficiency: v.total ? Math.round((v.completed / v.total) * 100) : 0,
      riskScore: v.total ? Math.round((v.delayed / v.total) * 100) : 0,
    }))
    .sort((a, b) => b.delayDays - a.delayDays);

  const stages = Object.entries(stageAgg).map(([stage, v]) => ({
    stage,
    total: v.total,
    delayed: v.delayed,
    delayDays: v.delayDays,
    healthPct: v.total ? Math.round(((v.total - v.delayed) / v.total) * 100) : 100,
  })).sort((a, b) => b.delayDays - a.delayDays);

  const processes = Object.entries(processAgg).map(([process, v]) => ({
    process, total: v.total, delayed: v.delayed, delayDays: v.delayDays,
  })).sort((a, b) => b.delayDays - a.delayDays).slice(0, 8);

  overdue.sort((a, b) => b.delay - a.delay);

  const completionRate = n ? Math.round((completedCount / n) * 100) : 0;
  const delayRate = n ? Math.round((delayedCount / n) * 100) : 0;
  const healthScore = Math.max(0, Math.min(100, 100 - delayRate + Math.round(completionRate / 3)));
  const avgDelay = delayedCount ? Math.round(totalDelay / delayedCount) : 0;

  // Rule-based Next Best Actions
  const actions: { id: string; title: string; detail: string; severity: keyof typeof SEV; source: string }[] = [];
  overdue.slice(0, 5).forEach((o, i) => {
    const sev = o.criticality === "Critical" || o.delay > 60 ? "high" : o.delay > 20 ? "medium" : "low";
    actions.push({
      id: `ov-${i}`,
      title: `Unblock "${o.activity}" (${o.delay}d overdue)`,
      detail: `Owned by ${o.person} · Stage ${o.stage} · TAT ${o.tat}d, taken ${o.taken}d. Escalate and set a recovery date.`,
      severity: sev as keyof typeof SEV,
      source: "Overdue",
    });
  });
  persons.slice(0, 3).forEach((p, i) => {
    if (p.riskScore >= 30) {
      actions.push({
        id: `p-${i}`,
        title: `Rebalance workload for ${p.person}`,
        detail: `${p.delayed}/${p.total} activities delayed (${p.riskScore}%). Redistribute or add support.`,
        severity: p.riskScore >= 60 ? "high" : "medium",
        source: "Person risk",
      });
    }
  });
  stages.slice(0, 2).forEach((s, i) => {
    if (s.delayed > 0 && s.healthPct < 70) {
      actions.push({
        id: `s-${i}`,
        title: `Fix bottleneck in ${s.stage}`,
        detail: `${s.delayed}/${s.total} activities delayed (${s.delayDays}d cumulative). Review process and dependencies.`,
        severity: s.healthPct < 40 ? "high" : "medium",
        source: "Stage",
      });
    }
  });
  const notStarted = status["Not Started"] || 0;
  if (notStarted > n * 0.25) {
    actions.push({
      id: "ns-1",
      title: `Kick off ${notStarted} not-started activities`,
      detail: `${Math.round((notStarted / n) * 100)}% of activities have not begun. Confirm dependencies are met and assign start dates.`,
      severity: "medium",
      source: "Backlog",
    });
  }

  return {
    rows, n, status, critAgg, persons, stages, processes, overdue,
    completionRate, delayRate, healthScore, avgDelay,
    totals: { total: n, completed: completedCount, delayed: delayedCount, overdue: overdueCount, notStarted },
    actions,
  };
}

export default function AgentDashboard() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET);
  const [activeUrl, setActiveUrl] = useState(DEFAULT_URL);
  const [activeSheet, setActiveSheet] = useState(DEFAULT_SHEET);
  const fetchFn = useServerFn(fetchInsightUrl);
  const fetchSheetFn = useServerFn(fetchSheetRows);
  const genFn = useServerFn(generateGeminiFn);

  const q = useQuery({
    queryKey: ["agent-export", activeUrl],
    queryFn: async () => fetchFn({ data: { url: activeUrl } }),
    enabled: !!activeUrl,
    staleTime: 60_000,
  });

  const sheetQ = useQuery({
    queryKey: ["agent-sheet", activeSheet],
    queryFn: async () => fetchSheetFn({ data: { spreadsheetId: activeSheet } }),
    enabled: !!activeSheet,
    staleTime: 60_000,
  });

  const exportPayload: Payload | undefined = (q.data as { payload?: Payload })?.payload;
  const sheetResult = sheetQ.data as { title?: string; sheetName?: string; columns?: string[]; rows?: Row[] } | undefined;

  // Sheet rows are authoritative when present; fall back to export.
  const payload: Payload | undefined = useMemo(() => {
    if (sheetResult?.rows?.length) {
      return {
        ...(exportPayload ?? {}),
        project: sheetResult.title || exportPayload?.project,
        sheet: sheetResult.sheetName || exportPayload?.sheet,
        columns: sheetResult.columns,
        count: sheetResult.rows.length,
        data: sheetResult.rows,
      };
    }
    return exportPayload;
  }, [exportPayload, sheetResult]);

  const d = useMemo(() => derive(payload), [payload]);

  const [brief, setBrief] = useState<string>("");
  const briefMut = useMutation({
    mutationFn: async () => {
      const facts = {
        project: payload?.project,
        totals: d.totals,
        health: d.healthScore,
        avg_delay_days: d.avgDelay,
        top_overdue: d.overdue.slice(0, 5).map(o => ({ activity: o.activity, person: o.person, delay: o.delay, criticality: o.criticality })),
        top_persons_at_risk: d.persons.slice(0, 3).map(p => ({ person: p.person, delayed: p.delayed, total: p.total, riskScore: p.riskScore })),
        worst_stages: d.stages.slice(0, 3).map(s => ({ stage: s.stage, delayed: s.delayed, total: s.total })),
      };
      const res = await genFn({
        data: {
          system: "You are an operations analyst. Use ONLY the FACTS. 3 crisp sentences. No hedging, no invented numbers.",
          prompt: `FACTS:\n${JSON.stringify(facts, null, 2)}\n\nWrite an executive brief: (1) overall state, (2) main risk, (3) most impactful next move.`,
          temperature: 0.2,
        },
      });
      return res.text;
    },
    onSuccess: (t) => setBrief(t),
  });

  useEffect(() => { setBrief(""); }, [activeUrl]);
  useEffect(() => {
    if (payload && !brief && !briefMut.isPending) briefMut.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  const statusData = Object.entries(d.status).map(([name, value]) => ({ name, value }));
  const stageData = d.stages.map(s => ({ name: s.stage, delayed: s.delayed, healthy: s.total - s.delayed }));
  const personData = d.persons.slice(0, 8).map(p => ({ name: p.person.split(" ")[0], delayDays: p.delayDays, delayed: p.delayed }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-gradient-to-br from-primary/5 via-background to-accent/5 p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary">
            <Sparkles className="h-3 w-3" /> Agentic AI
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
            {payload?.project || "Agent Dashboard"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live analytics pulled from your export link — recommendations, efficiency and risk grounded in real rows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sheetResult?.rows?.length ? (
            <Badge variant="outline" className="gap-1"><SheetIcon className="h-3 w-3" />Sheet · {sheetResult.rows.length} rows</Badge>
          ) : exportPayload?.data?.length ? (
            <Badge variant="outline" className="gap-1"><Link2 className="h-3 w-3" />Export · {exportPayload.data.length} rows</Badge>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => { q.refetch(); sheetQ.refetch(); }}>
            <RefreshCw className={`h-4 w-4 ${(q.isFetching || sheetQ.isFetching) ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Data sources */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Export link (/export?fields=…)"
              className="flex-1"
            />
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <SheetIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="Google Sheet link (authoritative when provided)"
              className="flex-1"
            />
            <Button
              onClick={() => { setActiveUrl(url); setActiveSheet(sheetUrl); }}
              disabled={q.isFetching || sheetQ.isFetching}
            >
              {(q.isFetching || sheetQ.isFetching) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyze
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Sheet rows override the export when available. Leave sheet blank to use only the export link.
          </p>
        </CardContent>
      </Card>

      {(q.isError || sheetQ.isError) && (
        <Card className="border-rose-500/40">
          <CardContent className="space-y-1 p-4 text-sm text-rose-600">
            {q.isError && <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Export: {(q.error as Error).message}</div>}
            {sheetQ.isError && <div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Sheet: {(sheetQ.error as Error).message}</div>}
          </CardContent>
        </Card>
      )}

      {(q.isLoading || sheetQ.isLoading) && !payload && (
        <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Pulling insights…
        </div>
      )}

      {payload && (
        <>
          {/* Executive brief */}
          <Card className="border-primary/30 bg-gradient-to-br from-primary/[0.04] to-transparent">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" /> Executive brief
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {briefMut.isPending && !brief ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Synthesising from live facts…
                </div>
              ) : (
                <p className="text-sm leading-relaxed">
                  {brief || "Tap refresh to generate a brief."}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="ghost" size="sm" onClick={() => briefMut.mutate()} disabled={briefMut.isPending}>
                  <RefreshCw className={`h-3.5 w-3.5 ${briefMut.isPending ? "animate-spin" : ""}`} /> Regenerate
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Hero KPIs */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi icon={<Activity className="h-4 w-4" />} label="Activities" value={d.totals.total} tone="default" />
            <Kpi icon={<CheckCircle2 className="h-4 w-4" />} label="Completion" value={`${d.completionRate}%`} tone="ok" sub={`${d.totals.completed} done`} />
            <Kpi icon={<Clock className="h-4 w-4" />} label="Delayed" value={d.totals.delayed} tone={d.delayRate > 15 ? "high" : "medium"} sub={`${d.delayRate}% of total`} />
            <Kpi icon={<TrendingUp className="h-4 w-4" />} label="Avg delay" value={`${d.avgDelay}d`} tone={d.avgDelay > 30 ? "high" : "medium"} />
            <Kpi icon={<Target className="h-4 w-4" />} label="Health" value={`${d.healthScore}`} tone={d.healthScore > 70 ? "ok" : d.healthScore > 40 ? "medium" : "high"} sub="0-100" />
          </div>

          <Tabs defaultValue="actions" className="w-full">
            <TabsList className="grid w-full grid-cols-2 md:grid-cols-5">
              <TabsTrigger value="actions"><Zap className="mr-1.5 h-3.5 w-3.5" />Actions</TabsTrigger>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="people"><Users className="mr-1.5 h-3.5 w-3.5" />People</TabsTrigger>
              <TabsTrigger value="stages">Stages</TabsTrigger>
              <TabsTrigger value="overdue">Overdue</TabsTrigger>
            </TabsList>

            {/* ACTIONS */}
            <TabsContent value="actions" className="space-y-3 pt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Sparkles className="h-4 w-4 text-primary" /> Next best actions
                    <Badge variant="secondary" className="ml-auto">{d.actions.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {d.actions.length === 0 && <p className="text-sm text-muted-foreground">No urgent actions. Nice.</p>}
                  {d.actions.map(a => (
                    <div key={a.id} className={`rounded-lg border p-3 ${SEV[a.severity]}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{a.source}</div>
                          <div className="mt-0.5 text-sm font-semibold">{a.title}</div>
                          <div className="mt-1 text-xs opacity-90">{a.detail}</div>
                        </div>
                        <Badge variant="outline" className="shrink-0 capitalize">{a.severity}</Badge>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>

            {/* OVERVIEW */}
            <TabsContent value="overview" className="grid gap-4 pt-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Status distribution</CardTitle></CardHeader>
                <CardContent className="h-64">
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={statusData} dataKey="value" nameKey="name" outerRadius={80} label>
                        {statusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Delay burden by process (top 8)</CardTitle></CardHeader>
                <CardContent className="h-64">
                  <ResponsiveContainer>
                    <BarChart data={d.processes} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis type="number" fontSize={11} />
                      <YAxis type="category" dataKey="process" fontSize={10} width={120} />
                      <Tooltip />
                      <Bar dataKey="delayDays" fill="#f43f5e" name="Delay days" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card className="md:col-span-2">
                <CardHeader className="pb-2"><CardTitle className="text-sm">Criticality mix</CardTitle></CardHeader>
                <CardContent className="h-56">
                  <ResponsiveContainer>
                    <BarChart data={Object.entries(d.critAgg).map(([name, value]) => ({ name, value }))}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis dataKey="name" fontSize={12} />
                      <YAxis fontSize={12} />
                      <Tooltip />
                      <Bar dataKey="value" fill="#6366f1" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </TabsContent>

            {/* PEOPLE */}
            <TabsContent value="people" className="space-y-4 pt-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Delay burden by owner (top 8)</CardTitle></CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <BarChart data={personData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis dataKey="name" fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="delayDays" fill="#f43f5e" name="Delay days" />
                      <Bar dataKey="delayed" fill="#f59e0b" name="Delayed activities" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Efficiency ranking</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Person</TableHead>
                        <TableHead className="text-right">Activities</TableHead>
                        <TableHead className="text-right">Completed</TableHead>
                        <TableHead className="text-right">Delayed</TableHead>
                        <TableHead className="text-right">Delay days</TableHead>
                        <TableHead>Efficiency</TableHead>
                        <TableHead>Risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.persons.slice(0, 15).map(p => (
                        <TableRow key={p.person}>
                          <TableCell className="font-medium">{p.person}</TableCell>
                          <TableCell className="text-right">{p.total}</TableCell>
                          <TableCell className="text-right">{p.completed}</TableCell>
                          <TableCell className="text-right">{p.delayed}</TableCell>
                          <TableCell className="text-right">{p.delayDays}</TableCell>
                          <TableCell className="w-32">
                            <div className="flex items-center gap-2">
                              <Progress value={p.efficiency} className="h-1.5" />
                              <span className="text-xs text-muted-foreground w-8">{p.efficiency}%</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={p.riskScore > 50 ? SEV.high : p.riskScore > 25 ? SEV.medium : SEV.ok}>
                              {p.riskScore}%
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>

            {/* STAGES */}
            <TabsContent value="stages" className="space-y-4 pt-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Stage health</CardTitle></CardHeader>
                <CardContent className="h-72">
                  <ResponsiveContainer>
                    <BarChart data={stageData}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                      <XAxis dataKey="name" fontSize={11} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="healthy" stackId="a" fill="#10b981" name="On track" />
                      <Bar dataKey="delayed" stackId="a" fill="#ef4444" name="Delayed" />
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <div className="grid gap-3 md:grid-cols-2">
                {d.stages.map(s => (
                  <Card key={s.stage}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-semibold">{s.stage}</div>
                        <Badge variant="outline" className={s.healthPct > 70 ? SEV.ok : s.healthPct > 40 ? SEV.medium : SEV.high}>
                          {s.healthPct}% healthy
                        </Badge>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {s.total} activities · {s.delayed} delayed · {s.delayDays}d cumulative delay
                      </div>
                      <Progress value={s.healthPct} className="mt-2 h-1.5" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            {/* OVERDUE */}
            <TabsContent value="overdue" className="pt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Top overdue activities ({d.overdue.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Activity</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Stage</TableHead>
                        <TableHead>Criticality</TableHead>
                        <TableHead className="text-right">TAT</TableHead>
                        <TableHead className="text-right">Taken</TableHead>
                        <TableHead className="text-right">Delay</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.overdue.slice(0, 25).map((o, i) => (
                        <TableRow key={i}>
                          <TableCell className="max-w-xs truncate font-medium">{o.activity}</TableCell>
                          <TableCell>{o.person}</TableCell>
                          <TableCell>{o.stage}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={o.criticality === "Critical" ? SEV.high : SEV.low}>
                              {o.criticality}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">{o.tat}</TableCell>
                          <TableCell className="text-right">{o.taken}</TableCell>
                          <TableCell className="text-right">
                            <Badge className={o.delay > 60 ? SEV.high : o.delay > 20 ? SEV.medium : SEV.low}>
                              {o.delay}d
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone }: {
  icon: React.ReactNode; label: string; value: string | number; sub?: string;
  tone: "default" | "ok" | "medium" | "high";
}) {
  const toneCls = tone === "ok" ? SEV.ok : tone === "medium" ? SEV.medium : tone === "high" ? SEV.high : "border-border/60 bg-card";
  return (
    <Card className={`border ${toneCls}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest opacity-70">
          {icon} {label}
        </div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
        {sub && <div className="mt-0.5 text-[11px] opacity-70">{sub}</div>}
      </CardContent>
    </Card>
  );
}
