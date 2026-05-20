import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  fetchDashboard, mergeData, type DashboardData, type ExtraEntry,
} from "@/lib/dashboard-data";
import { askChatbot } from "@/lib/chat.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, Upload, Plus, AlertTriangle, CheckCircle2, Clock, TrendingUp, Bot, Database, Sparkles, Flag, FileSearch, ChevronDown, ChevronUp, Quote, FileDown, FileSpreadsheet, Mail, MessageSquare, Wand2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { exportFlagsCsv, exportFlagsPdf } from "@/lib/export-flags";
import type { FlagEntry } from "@/lib/dashboard-data";
import type { Citation } from "@/lib/chat.functions";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "DelayLens — Project Delay Intelligence" },
    { name: "description", content: "Attractive analytics dashboard for project delays, dependencies, TAT and people performance with a data-bound AI assistant." },
  ]}),
  component: Dashboard,
});

const STORAGE_KEY = "dashboard.extras.v1";
const COLORS = ["oklch(0.78 0.18 145)", "oklch(0.72 0.19 50)", "oklch(0.7 0.18 280)", "oklch(0.75 0.18 200)", "oklch(0.7 0.2 10)", "oklch(0.68 0.03 255)"];

function Dashboard() {
  const { data: base, isLoading, error, refetch } = useQuery({
    queryKey: ["dashboard"],
    queryFn: fetchDashboard,
  });

  const [extras, setExtras] = useState<ExtraEntry[]>([]);
  useEffect(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) setExtras(JSON.parse(s)); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(extras)); } catch {}
  }, [extras]);

  const data: DashboardData | undefined = useMemo(
    () => (base ? mergeData(base, extras) : undefined),
    [base, extras],
  );

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="mx-auto max-w-[1400px] px-6 pb-24">
        {isLoading && <div className="py-32 text-center text-muted-foreground">Loading dashboard…</div>}
        {error && <div className="py-32 text-center text-destructive">Failed to load. <Button variant="link" onClick={() => refetch()}>Retry</Button></div>}
        {data && (
          <>
            <SummaryBar data={data} extrasCount={extras.length} />
            <KpiGrid data={data} />
            <div className="mt-8 grid gap-6 lg:grid-cols-3">
              <StatusChart data={data} />
              <ReasonsChart data={data} />
              <RiskGauge data={data} />
            </div>
            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <PersonRanking data={data} />
              <DeptRanking data={data} />
            </div>
            <TatTable data={data} />
            <FlagsPanel data={data} />
            <DataFeed extras={extras} setExtras={setExtras} data={data} />
          </>
        )}
      </main>
      {data && <Copilot data={data} />}
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}>
            <Sparkles className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">DelayLens</h1>
            <p className="text-xs text-muted-foreground">Project Delay Intelligence</p>
          </div>
        </div>
        <div className="hidden gap-2 text-xs text-muted-foreground sm:flex">
          <span className="rounded-full border border-border px-3 py-1">Live data</span>
          <span className="rounded-full border border-border px-3 py-1">AI assistant</span>
        </div>
      </div>
    </header>
  );
}

function SummaryBar({ data, extrasCount }: { data: DashboardData; extrasCount: number }) {
  return (
    <div className="mt-8 rounded-2xl border border-border bg-card p-6" style={{ boxShadow: "var(--shadow-card)" }}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">{data.mode_badge ?? "Delay Analysis"}</p>
          <h2 className="mt-2 text-2xl font-semibold">{data.summary}</h2>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {extrasCount > 0 && (
            <span className="rounded-full bg-primary/15 px-3 py-1.5 text-primary">+{extrasCount} added locally</span>
          )}
          {data.sheets?.[0] && (
            <span className="text-muted-foreground">Source: {data.sheets[0].name} · {data.sheets[0].rows} rows</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, accent }: { icon: any; label: string; value: string | number; accent?: string }) {
  return (
    <Card className="border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold">{value}</p>
        </div>
        <div className="grid h-10 w-10 place-items-center rounded-lg" style={{ background: accent ?? "var(--secondary)" }}>
          <Icon className="h-5 w-5 text-primary-foreground" />
        </div>
      </div>
    </Card>
  );
}

function KpiGrid({ data }: { data: DashboardData }) {
  const t = data.totals;
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <Kpi icon={Database} label="Total Rows" value={t.rows} accent="var(--secondary)" />
      <Kpi icon={AlertTriangle} label="Delayed" value={t.delayed} accent="var(--gradient-danger)" />
      <Kpi icon={CheckCircle2} label="Completed" value={t.completed} accent="var(--gradient-hero)" />
      <Kpi icon={Clock} label="Blocked" value={t.blocked} accent="var(--secondary)" />
      <Kpi icon={TrendingUp} label="Risk Score" value={`${data.risk_score}`} accent="var(--gradient-danger)" />
    </div>
  );
}

function StatusChart({ data }: { data: DashboardData }) {
  const rows = Object.entries(data.status_breakdown).map(([name, value]) => ({ name, value }));
  return (
    <Card className="border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">Status Breakdown</h3>
      <div className="mt-4 h-64">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
              {rows.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ background: "oklch(0.21 0.025 265)", border: "1px solid oklch(0.3 0.03 265)", borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function ReasonsChart({ data }: { data: DashboardData }) {
  const rows = data.top_delay_reasons.slice(0, 6).map((r) => ({ name: r.reason, count: r.count, days: r.total_overdue_days }));
  return (
    <Card className="border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">Top Delay Reasons</h3>
      <div className="mt-4 h-64">
        <ResponsiveContainer>
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.3 0.03 265)" />
            <XAxis dataKey="name" stroke="oklch(0.68 0.03 255)" fontSize={11} />
            <YAxis stroke="oklch(0.68 0.03 255)" fontSize={11} />
            <Tooltip contentStyle={{ background: "oklch(0.21 0.025 265)", border: "1px solid oklch(0.3 0.03 265)", borderRadius: 8 }} />
            <Bar dataKey="count" fill="oklch(0.78 0.18 145)" radius={[6,6,0,0]} />
            <Bar dataKey="days" fill="oklch(0.72 0.19 50)" radius={[6,6,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function RiskGauge({ data }: { data: DashboardData }) {
  const score = data.risk_score;
  const level = score >= 75 ? "Critical" : score >= 50 ? "High" : score >= 25 ? "Moderate" : "Low";
  const color = score >= 75 ? "var(--destructive)" : score >= 50 ? "var(--accent)" : "var(--primary)";
  return (
    <Card className="border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">Project Risk</h3>
      <div className="mt-6 flex flex-col items-center justify-center">
        <div className="relative h-44 w-44">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="oklch(0.3 0.03 265)" strokeWidth="10" />
            <circle cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="10"
              strokeDasharray={`${(score/100)*264} 264`} strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <div className="text-center">
              <p className="text-4xl font-bold">{score}</p>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{level}</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function PersonRanking({ data }: { data: DashboardData }) {
  const rows = data.person_ranking.slice(0, 8);
  const max = Math.max(...rows.map((r) => r.total_overdue_days), 1);
  return (
    <Card className="border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">People — Overdue Days</h3>
      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <div key={r.person}>
            <div className="flex items-center justify-between text-sm">
              <span className="truncate font-medium">{r.person}</span>
              <span className="text-muted-foreground">{r.delay_count} delays · {r.total_overdue_days}d</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${(r.total_overdue_days/max)*100}%`, background: "var(--gradient-hero)" }} />
            </div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted-foreground">No data.</p>}
      </div>
    </Card>
  );
}

function DeptRanking({ data }: { data: DashboardData }) {
  const rows = data.department_ranking;
  const max = Math.max(...rows.map((r) => r.total_overdue_days), 1);
  return (
    <Card className="border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">Departments — Overdue Days</h3>
      <div className="mt-4 space-y-3">
        {rows.map((r) => (
          <div key={r.department}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{r.department}</span>
              <span className="text-muted-foreground">{r.delay_count} delays · {r.total_overdue_days}d</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full" style={{ width: `${(r.total_overdue_days/max)*100}%`, background: "var(--gradient-danger)" }} />
            </div>
          </div>
        ))}
        {!rows.length && <p className="text-sm text-muted-foreground">No data.</p>}
      </div>
    </Card>
  );
}

function TatTable({ data }: { data: DashboardData }) {
  const rows = data.tat_performance.rows.slice(0, 12);
  return (
    <Card className="mt-8 border-border bg-card p-5">
      <h3 className="text-sm font-semibold text-muted-foreground">TAT Performance — Worst Overruns</h3>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-2 pr-4">Activity</th>
              <th className="py-2 pr-4">Owner</th>
              <th className="py-2 pr-4">TAT</th>
              <th className="py-2 pr-4">Taken</th>
              <th className="py-2 pr-4">Overrun %</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/40 last:border-0">
                <td className="max-w-md truncate py-3 pr-4">{r.activity}</td>
                <td className="py-3 pr-4 text-muted-foreground">{r.person}</td>
                <td className="py-3 pr-4">{r.tat}d</td>
                <td className="py-3 pr-4">{r.days_taken}d</td>
                <td className="py-3 pr-4">
                  <span className="rounded-md bg-destructive/15 px-2 py-0.5 text-destructive">{r.overrun_pct.toFixed(0)}%</span>
                </td>
                <td className="py-3">
                  <span className={`rounded-md px-2 py-0.5 text-xs ${r.status === "Completed" ? "bg-primary/15 text-primary" : "bg-accent/15 text-accent"}`}>{r.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function DataFeed({ extras, setExtras, data }: { extras: ExtraEntry[]; setExtras: (e: ExtraEntry[]) => void; data: DashboardData }) {
  const [form, setForm] = useState<Partial<ExtraEntry>>({ status: "Delayed", reason: "Other" });
  const fileRef = useRef<HTMLInputElement>(null);

  const add = () => {
    if (!form.person || !form.department || !form.activity) return;
    const entry: ExtraEntry = {
      id: crypto.randomUUID(),
      person: form.person!,
      department: form.department!,
      activity: form.activity!,
      reason: form.reason || "Other",
      overdue_days: Number(form.overdue_days || 0),
      status: form.status || "Delayed",
      tat: form.tat ? Number(form.tat) : undefined,
      days_taken: form.days_taken ? Number(form.days_taken) : undefined,
    };
    setExtras([entry, ...extras]);
    setForm({ status: "Delayed", reason: "Other" });
  };

  const onFile = async (f: File) => {
    const text = await f.text();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) setExtras([...parsed, ...extras]);
    } catch {
      // CSV: person,department,activity,reason,overdue_days,status
      const lines = text.trim().split(/\r?\n/).slice(1);
      const rows: ExtraEntry[] = lines.map((l) => {
        const [person, department, activity, reason, overdue_days, status] = l.split(",");
        return { id: crypto.randomUUID(), person, department, activity, reason: reason || "Other", overdue_days: Number(overdue_days||0), status: status || "Delayed" };
      }).filter((r) => r.person);
      setExtras([...rows, ...extras]);
    }
  };

  return (
    <Card className="mt-8 border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground">Feed Data</h3>
          <p className="text-xs text-muted-foreground">Add entries manually or upload CSV/JSON. All charts, rankings and the chatbot update instantly.</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".json,.csv" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Upload</Button>
          {extras.length > 0 && <Button variant="ghost" size="sm" onClick={() => setExtras([])}>Clear local</Button>}
        </div>
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-4">
        <Input placeholder="Person" value={form.person||""} onChange={(e) => setForm({...form, person: e.target.value})} />
        <Input placeholder="Department" value={form.department||""} onChange={(e) => setForm({...form, department: e.target.value})} />
        <Input placeholder="Activity" value={form.activity||""} onChange={(e) => setForm({...form, activity: e.target.value})} className="md:col-span-2" />
        <Input placeholder="Reason (e.g. Approval Pending)" value={form.reason||""} onChange={(e) => setForm({...form, reason: e.target.value})} />
        <Input placeholder="Overdue days" type="number" value={form.overdue_days as any || ""} onChange={(e) => setForm({...form, overdue_days: Number(e.target.value)})} />
        <Input placeholder="TAT (days)" type="number" value={form.tat as any || ""} onChange={(e) => setForm({...form, tat: Number(e.target.value)})} />
        <Input placeholder="Days taken" type="number" value={form.days_taken as any || ""} onChange={(e) => setForm({...form, days_taken: Number(e.target.value)})} />
        <select className="rounded-md border border-input bg-input px-3 py-2 text-sm" value={form.status} onChange={(e) => setForm({...form, status: e.target.value})}>
          {["Delayed", "Completed", "In Progress", "Yet to Start"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <Button onClick={add} className="md:col-span-2"><Plus className="mr-2 h-4 w-4" />Add Entry</Button>
      </div>

      {extras.length > 0 && (
        <div className="mt-4 text-xs text-muted-foreground">
          {extras.length} local entr{extras.length===1?"y":"ies"} merged. Totals now: {data.totals.rows} rows · {data.totals.delayed} delayed.
        </div>
      )}
    </Card>
  );
}

function FlagsPanel({ data }: { data: DashboardData }) {
  const flags = data.flags ?? [];
  const [selected, setSelected] = useState<FlagEntry | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [shareMode, setShareMode] = useState<null | "email" | "sms">(null);
  const visible = showAll ? flags : flags.slice(0, 8);
  const sevColor = (s?: string) => {
    const v = (s || "").toLowerCase();
    if (v === "critical") return "bg-destructive/15 text-destructive";
    if (v === "high") return "bg-accent/15 text-accent";
    if (v === "medium") return "bg-primary/15 text-primary";
    return "bg-secondary text-muted-foreground";
  };

  return (
    <Card className="mt-8 border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: "var(--gradient-danger)" }}>
            <Flag className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Flags</h3>
            <p className="text-xs text-muted-foreground">{flags.length} flagged item{flags.length === 1 ? "" : "s"} — open Source to see the issue origin.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { exportFlagsCsv(data); toast.success("CSV downloaded"); }}>
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => { exportFlagsPdf(data); toast.success("PDF downloaded"); }}>
            <FileDown className="mr-1.5 h-4 w-4" /> PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShareMode("email")}>
            <Mail className="mr-1.5 h-4 w-4" /> Email
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShareMode("sms")}>
            <MessageSquare className="mr-1.5 h-4 w-4" /> SMS
          </Button>
        </div>
      </div>

      <ShareDialog mode={shareMode} onClose={() => setShareMode(null)} flagCount={flags.length} />


      {!flags.length && <p className="mt-4 text-sm text-muted-foreground">No flags in current dataset.</p>}

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
              {visible.map((f) => (
                <tr key={f.id} className="border-b border-border/40 last:border-0">
                  <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{f.id}</td>
                  <td className="max-w-xs truncate py-3 pr-4">{f.activity}</td>
                  <td className="py-3 pr-4 text-muted-foreground">{f.flagged_to?.person ?? "—"}</td>
                  <td className="py-3 pr-4 text-muted-foreground">{f.stage ?? "—"}</td>
                  <td className="py-3 pr-4">{f.overdue_days ?? 0}d</td>
                  <td className="py-3 pr-4"><span className={`rounded-md px-2 py-0.5 text-xs ${sevColor(f.severity)}`}>{f.severity ?? "—"}</span></td>
                  <td className="py-3 pr-4 text-muted-foreground">{f.status ?? "—"}</td>
                  <td className="py-3">
                    <Button size="sm" variant="outline" onClick={() => setSelected(f)}>
                      <FileSearch className="mr-1.5 h-3.5 w-3.5" /> Source
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {flags.length > 8 && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((s) => !s)}>
              {showAll ? <><ChevronUp className="mr-1 h-4 w-4" /> Show less</> : <><ChevronDown className="mr-1 h-4 w-4" /> Show all {flags.length}</>}
            </Button>
          )}
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Flag className="h-4 w-4 text-destructive" />
              <span>{selected?.id} — Source</span>
            </DialogTitle>
          </DialogHeader>
          {selected && (() => {
            const owner = selected.flagged_to?.person;
            const reason = selected.reason_text?.trim() || selected.reason || "Not specified";
            const overrun = selected.tat && selected.days_taken ? Math.max(0, selected.days_taken - selected.tat) : (selected.overdue_days ?? 0);
            const overrunPct = selected.tat && selected.days_taken ? Math.round(((selected.days_taken - selected.tat) / selected.tat) * 100) : null;
            const personRow = owner ? data.person_ranking.find((p) => p.person === owner) : undefined;
            const tatRow = data.tat_performance.rows.find((r) => r.activity === selected.activity);
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
                  <p className="mt-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">Reason flagged:</span> {reason}</p>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <Field label="Activity" value={selected.activity} />
                  <Field label="Responsible" value={owner ?? "—"} />
                  <Field label="Stage" value={selected.stage ?? "—"} />
                  <Field label="Severity" value={selected.severity ?? "—"} />
                  <Field label="Planned TAT" value={selected.tat != null ? `${selected.tat} days` : "—"} />
                  <Field label="Actual taken" value={selected.days_taken != null ? `${selected.days_taken} days` : "Not started"} />
                  <Field label="Overdue" value={`${selected.overdue_days ?? 0} days`} />
                  <Field label="Escalation" value={`Level ${selected.escalation_level ?? 0}`} />
                </div>

                <div>
                  <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Where this surfaced</p>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li>• Flag record <span className="font-mono text-foreground">{selected.id}</span> from the source dataset.</li>
                    {tatRow && <li>• Appears in TAT performance with {tatRow.overrun_pct.toFixed(0)}% overrun.</li>}
                    {personRow && <li>• {personRow.person} is linked to {personRow.delay_count} delay(s) totaling {personRow.total_overdue_days}d overdue.</li>}
                    {!personRow && owner && <li>• {owner} is not currently in the people-ranking aggregate.</li>}
                  </ul>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </Card>
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

function ShareDialog({ mode, onClose, flagCount }: { mode: null | "email" | "sms"; onClose: () => void; flagCount: number }) {
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const isEmail = mode === "email";
  const send = () => {
    if (!to.trim()) { toast.error(`Enter a ${isEmail ? "recipient email" : "phone number"}`); return; }
    toast.success(`${isEmail ? "Email" : "SMS"} queued for ${to} — third-party delivery integration pending.`);
    setTo(""); setNote(""); onClose();
  };
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEmail ? <Mail className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
            <span>Send Flags Report via {isEmail ? "Email" : "SMS"}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder={isEmail ? "name@company.com" : "+1 555 123 4567"}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <Textarea
            placeholder={`Optional note to include with the ${flagCount}-flag report…`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
          />
          <p className="rounded-md border border-border bg-background/40 p-2 text-xs text-muted-foreground">
            Delivery provider not yet connected. The button below records the intent; we'll wire {isEmail ? "Resend/SendGrid" : "Twilio"} when you're ready.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={send}><Send className="mr-1.5 h-4 w-4" />Send</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const QUICK_ACTIONS = [
  { icon: TrendingUp, label: "Predict at-risk", prompt: "Predict the next 3 activities or people most likely to slip. Cite the data." },
  { icon: AlertTriangle, label: "Top dependencies", prompt: "Which delays are blocking the most downstream work? Explain the dependency chain." },
  { icon: Wand2, label: "Advice", prompt: "Give me 3 concrete actions to reduce the project risk score this week." },
  { icon: FileDown, label: "Generate report", prompt: "Generate a PDF flags report and download it." },
];

function Copilot({ data }: { data: DashboardData }) {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  type ChatMsg = { role: "user" | "assistant"; content: string; citations?: Citation[] };
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: "I'm your **DelayLens Copilot**. I can predict at-risk items, explain dependencies, advise next actions, and generate reports — all grounded in your live dashboard data with citations." },
  ]);
  const ask = useServerFn(askChatbot);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 1e9 }); }, [messages, open]);

  const compact = useMemo(() => JSON.stringify({
    summary: data.summary,
    totals: data.totals,
    risk_score: data.risk_score,
    status_breakdown: data.status_breakdown,
    top_delay_reasons: data.top_delay_reasons,
    person_ranking: data.person_ranking,
    department_ranking: data.department_ranking,
    tat_performance: data.tat_performance,
    flags: data.flags,
  }), [data]);

  const runAction = (action: "export_flags_pdf" | "export_flags_csv" | "none") => {
    if (action === "export_flags_pdf") { exportFlagsPdf(data); toast.success("Flags PDF downloaded"); }
    if (action === "export_flags_csv") { exportFlagsCsv(data); toast.success("Flags CSV downloaded"); }
  };

  const sendQ = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: "user", content: q }]);
    try {
      const r = await ask({ data: { question: q, dataJson: compact, history } });
      setMessages((m) => [...m, { role: "assistant", content: r.answer, citations: r.citations }]);
      runAction(r.action ?? "none");
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry, I couldn't answer right now. " + (e?.message ?? "") }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => { const q = input.trim(); setInput(""); await sendQ(q); };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full px-5 py-3 text-sm font-medium text-primary-foreground transition-transform hover:scale-105"
          style={{ background: "var(--gradient-hero)", boxShadow: "var(--shadow-glow)" }}
          aria-label="Open Copilot"
        >
          <Bot className="h-5 w-5" /> Copilot
        </button>
      )}
      {open && (
        <aside
          className="fixed right-0 top-0 z-40 flex h-screen w-full flex-col border-l border-border bg-card sm:w-[420px]"
          style={{ boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: "var(--gradient-hero)" }}>
                <Bot className="h-5 w-5 text-primary-foreground" />
              </div>
              <div>
                <p className="text-sm font-semibold">DelayLens Copilot</p>
                <p className="text-xs text-muted-foreground">Predictions · Advice · Reports</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.label}
                onClick={() => sendQ(a.prompt)}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-full border border-border bg-background/40 px-2.5 py-1 text-[11px] text-foreground hover:bg-secondary disabled:opacity-50"
              >
                <a.icon className="h-3 w-3" /> {a.label}
              </button>
            ))}
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{m.content}</div>
                ) : (
                  <div className="space-y-2">
                    <div className="prose prose-sm prose-invert max-w-none text-sm text-foreground [&_p]:my-1 [&_ul]:my-1 [&_table]:text-xs">
                      <ReactMarkdown>{m.content}</ReactMarkdown>
                    </div>
                    {m.citations && m.citations.length > 0 && <CitationsBlock items={m.citations} />}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="text-xs text-muted-foreground">Thinking…</div>}
          </div>

          <div className="border-t border-border p-3">
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Ask for a prediction, advice, or a report…"
              />
              <Button onClick={send} disabled={busy} size="icon"><Send className="h-4 w-4" /></Button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}

function CitationsBlock({ items }: { items: Citation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-background/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Quote className="h-3 w-3" />
          {open ? "Hide sources" : `Show sources (${items.length})`}
        </span>
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-border px-3 py-2 text-xs">
          {items.map((c, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{c.label}</span>
              <span className="text-muted-foreground">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">{c.source}</span>
                <span className="ml-2 italic">"{c.value}"</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
