import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { listSheets } from "@/lib/sheets.functions";
import { buildDashboardFromSheets } from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Send, Upload, Plus, AlertTriangle, CheckCircle2, Clock, TrendingUp, Bot, Database, Sparkles, Flag, FileSearch, ChevronDown, ChevronUp, Quote, FileDown, FileSpreadsheet, Mail, MessageSquare, Wand2, X, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { exportFlagsCsv, exportFlagsPdf } from "@/lib/export-flags";
import type { FlagEntry } from "@/lib/dashboard-data";
import type { Citation } from "@/lib/chat.functions";
import { DEFAULT_LOGIC } from "@/lib/dependency-inference";
import { inferDependenciesEmergent } from "@/lib/dependencies.functions";
import { RaiseConcernDialog } from "@/components/RaiseConcernDialog";
import type { DependencyChainResponse } from "@/lib/dependency-chain";
import { depStore, type DepSnapshot } from "@/lib/dep-store";
import { DependencyFlow, type Activity } from "@/components/DependencyFlow";
import { useDashboardWidgets } from "@/hooks/useDashboardWidgets";
import { useIsSuper } from "@/hooks/useSession";
import { MyDependentActivities } from "@/components/MyDependentActivities";


export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [
    { title: "DelayLens — Project Delay Intelligence" },
    { name: "description", content: "Attractive analytics dashboard for project delays, dependencies, TAT and people performance with a data-bound AI assistant." },
  ]}),
  component: Dashboard,
});

const STORAGE_KEY = "dashboard.extras.v1";
const SHEETS_KEY = "dashboard.selectedSheets.v1";
const COLORS = ["var(--chart-1)", "var(--chart-3)", "var(--chart-2)", "var(--chart-5)", "var(--chart-4)", "var(--muted-foreground)"];

function Dashboard() {
  const isSuper = useIsSuper();
  const [selectedSheetIds, setSelectedSheetIds] = useState<string[]>([]);
  useEffect(() => {
    try { const s = localStorage.getItem(SHEETS_KEY); if (s) setSelectedSheetIds(JSON.parse(s)); } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SHEETS_KEY, JSON.stringify(selectedSheetIds)); } catch {}
  }, [selectedSheetIds]);

  const listSheetsFn = useServerFn(listSheets);
  const { data: sheetsList } = useQuery({
    queryKey: ["sheets-list"],
    queryFn: () => listSheetsFn(),
  });

  const buildFn = useServerFn(buildDashboardFromSheets);
  const dynamic = selectedSheetIds.length > 0;

  const { data: base, isLoading, error, refetch } = useQuery({
    queryKey: dynamic ? ["dashboard", "dynamic", ...selectedSheetIds] : ["dashboard", "static"],
    queryFn: () =>
      dynamic
        ? buildFn({ data: { sheetIds: selectedSheetIds } })
        : fetchDashboard(),
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

  const { widgets } = useDashboardWidgets();

  const renderWidget = (id: string) => {
    if (!data) return null;
    switch (id) {
      case "summary": return <SummaryBar key={id} data={data} extrasCount={extras.length} />;
      case "kpi": return <KpiGrid key={id} data={data} />;
      case "charts":
        return (
          <div key={id} className="mt-6 grid gap-6 lg:grid-cols-3">
            <StatusChart data={data} />
            <ReasonsChart data={data} />
            <RiskGauge data={data} />
          </div>
        );
      case "rankings":
        return (
          <div key={id} className="mt-6 grid gap-6 lg:grid-cols-2">
            <PersonRanking data={data} />
            <DeptRanking data={data} />
          </div>
        );
      case "tat": return <TatTable key={id} data={data} />;
      case "flags": return <FlagsPanel key={id} data={data} />;
      case "dependencies": return isSuper ? <DependencyChainPanel key={id} /> : null;
      case "feed": return <DataFeed key={id} extras={extras} setExtras={setExtras} data={data} />;
      default: return null;
    }
  };

  return (
    <main className="w-full px-4 pb-24 pt-6 sm:px-6 lg:pr-[440px]">
      <div className="mx-auto max-w-[1400px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              {dynamic
                ? `Aggregated from ${selectedSheetIds.length} sheet${selectedSheetIds.length === 1 ? "" : "s"}.`
                : "Static demo source. Pick sheets below to go live."}
            </p>
          </div>
          <SheetPicker
            sheets={sheetsList?.sheets ?? []}
            selected={selectedSheetIds}
            onChange={setSelectedSheetIds}
          />
        </div>
        {isLoading && <div className="py-32 text-center text-muted-foreground">Loading dashboard…</div>}
        {error && <div className="py-32 text-center text-destructive">Failed to load. <Button variant="link" onClick={() => refetch()}>Retry</Button></div>}
        {data && (
          <div className="space-y-2">
            <MyDependentActivities />
            {widgets.filter((w) => w.visible).map((w) => renderWidget(w.id))}
          </div>
        )}
      </div>
      {data && <Copilot data={data} sheetIds={selectedSheetIds} />}
    </main>
  );
}

function SheetPicker({
  sheets,
  selected,
  onChange,
}: {
  sheets: { id: string; display_name: string; sheet_type: string; row_count: number | null }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const label = selected.length === 0
    ? "Select sheets"
    : selected.length === sheets.length
      ? `All ${sheets.length} sheets`
      : `${selected.length} of ${sheets.length} sheets`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Database className="mr-2 h-4 w-4" />
          {label}
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Data sources</p>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange(sheets.map((s) => s.id))}>All</Button>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onChange([])}>None</Button>
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {sheets.length === 0 && (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No sheets registered yet. Add one from the Sheets page.
            </p>
          )}
          {sheets.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-secondary">
              <Checkbox
                checked={selected.includes(s.id)}
                onCheckedChange={() => toggle(s.id)}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.display_name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.sheet_type} · {s.row_count ?? 0} rows
                </p>
              </div>
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
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
            <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid oklch(0.3 0.03 265)", borderRadius: 8 }} />
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
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="name" stroke="var(--muted-foreground)" fontSize={11} />
            <YAxis stroke="var(--muted-foreground)" fontSize={11} />
            <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid oklch(0.3 0.03 265)", borderRadius: 8 }} />
            <Bar dataKey="count" fill="var(--chart-1)" radius={[6,6,0,0]} />
            <Bar dataKey="days" fill="var(--chart-3)" radius={[6,6,0,0]} />
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
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--border)" strokeWidth="10" />
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
  const navigate = useNavigate();
  const allFlags = data.flags ?? [];
  const [selected, setSelected] = useState<FlagEntry | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [shareMode, setShareMode] = useState<null | "email" | "sms">(null);
  const [concernFor, setConcernFor] = useState<FlagEntry | null>(null);

  const [search, setSearch] = useState("");
  const [fSeverity, setFSeverity] = useState("all");
  const [fStatus, setFStatus] = useState("all");
  const [fStage, setFStage] = useState("all");
  const [fOwner, setFOwner] = useState("all");
  const [minOverdue, setMinOverdue] = useState<string>("");

  const uniq = (arr: (string | undefined)[]) =>
    Array.from(new Set(arr.filter(Boolean) as string[])).sort();
  const severities = useMemo(() => uniq(allFlags.map((f) => f.severity)), [allFlags]);
  const statuses = useMemo(() => uniq(allFlags.map((f) => f.status)), [allFlags]);
  const stages = useMemo(() => uniq(allFlags.map((f) => f.stage)), [allFlags]);
  const owners = useMemo(() => uniq(allFlags.map((f) => f.flagged_to?.person)), [allFlags]);

  const flags = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = Number(minOverdue) || 0;
    return allFlags.filter((f) => {
      if (fSeverity !== "all" && (f.severity ?? "") !== fSeverity) return false;
      if (fStatus !== "all" && (f.status ?? "") !== fStatus) return false;
      if (fStage !== "all" && (f.stage ?? "") !== fStage) return false;
      if (fOwner !== "all" && (f.flagged_to?.person ?? "") !== fOwner) return false;
      if ((f.overdue_days ?? 0) < min) return false;
      if (q) {
        const hay = `${f.id} ${f.activity} ${f.flagged_to?.person ?? ""} ${f.reason_text ?? ""} ${f.reason ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allFlags, search, fSeverity, fStatus, fStage, fOwner, minOverdue]);

  const visible = showAll ? flags : flags.slice(0, 8);
  const activeFilters =
    (fSeverity !== "all" ? 1 : 0) + (fStatus !== "all" ? 1 : 0) +
    (fStage !== "all" ? 1 : 0) + (fOwner !== "all" ? 1 : 0) +
    (minOverdue ? 1 : 0) + (search ? 1 : 0);
  const resetFilters = () => {
    setSearch(""); setFSeverity("all"); setFStatus("all");
    setFStage("all"); setFOwner("all"); setMinOverdue("");
  };

  const sevColor = (s?: string) => {
    const v = (s || "").toLowerCase();
    if (v === "critical") return "bg-destructive/15 text-destructive";
    if (v === "high") return "bg-accent/15 text-accent";
    if (v === "medium") return "bg-primary/15 text-primary";
    return "bg-secondary text-muted-foreground";
  };

  const selectCls = "rounded-md border border-input bg-input px-2 py-1.5 text-xs";

  return (
    <Card className="mt-8 border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: "var(--gradient-danger)" }}>
            <Flag className="h-4 w-4 text-primary-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Flags</h3>
            <p className="text-xs text-muted-foreground">
              Showing {flags.length} of {allFlags.length} flag{allFlags.length === 1 ? "" : "s"}
              {activeFilters > 0 ? ` · ${activeFilters} filter${activeFilters === 1 ? "" : "s"} active` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!flags.length} onClick={() => { exportFlagsCsv(data, flags); toast.success(`CSV downloaded (${flags.length} flag${flags.length===1?"":"s"})`); }}>
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> CSV
          </Button>
          <Button size="sm" variant="outline" disabled={!flags.length} onClick={() => { exportFlagsPdf(data, flags); toast.success(`PDF downloaded (${flags.length} flag${flags.length===1?"":"s"})`); }}>
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

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
        <Input placeholder="Search activity, owner, reason…" value={search} onChange={(e) => setSearch(e.target.value)} className="lg:col-span-2 h-9 text-xs" />
        <select className={selectCls} value={fSeverity} onChange={(e) => setFSeverity(e.target.value)}>
          <option value="all">All severities</option>
          {severities.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={selectCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={selectCls} value={fStage} onChange={(e) => setFStage(e.target.value)}>
          <option value="all">All stages</option>
          {stages.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className={selectCls} value={fOwner} onChange={(e) => setFOwner(e.target.value)}>
          <option value="all">All owners</option>
          {owners.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <Input placeholder="Min overdue days" type="number" min={0} value={minOverdue} onChange={(e) => setMinOverdue(e.target.value)} className="h-9 text-xs" />
        {activeFilters > 0 && (
          <Button variant="ghost" size="sm" onClick={resetFilters} className="justify-self-start">
            <X className="mr-1 h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
      </div>

      <ShareDialog mode={shareMode} onClose={() => setShareMode(null)} flagCount={flags.length} />

      {!flags.length && <p className="mt-4 text-sm text-muted-foreground">No flags match the current filters.</p>}

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
                  <td className="py-3 pr-4"><span className={`rounded-md px-2 py-0.5 text-xs ${sevColor(f.severity)}`}>{f.severity ?? "—"}</span></td>
                  <td className="py-3 pr-4 text-muted-foreground">{f.status ?? "—"}</td>
                  <td className="py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => { e.stopPropagation(); navigate({ to: "/alerts/$id", params: { id: f.id } }); }}
                    >
                      <FileSearch className="mr-1.5 h-3.5 w-3.5" /> View alert
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

                <div className="flex justify-end border-t border-border pt-3">
                  <Button size="sm" variant="outline" onClick={() => { setConcernFor(selected); setSelected(null); }}>
                    <AlertTriangle className="mr-1.5 h-3.5 w-3.5 text-amber-500" /> Raise concern
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <RaiseConcernDialog
        open={!!concernFor}
        onOpenChange={(o) => !o && setConcernFor(null)}
        defaultActivity={concernFor?.activity ?? null}
        ownerEmail={concernFor?.flagged_to?.email ?? null}
      />
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

function Copilot({ data, sheetIds: _sheetIds }: { data: DashboardData; sheetIds?: string[] }) {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dep, setDep] = useState<DepSnapshot>(() => depStore.get());
  useEffect(() => depStore.subscribe(() => setDep(depStore.get())), []);
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
    dependency_chain: dep.chain ? {
      nodes: dep.chain.chain.nodes,
      directEdges: dep.chain.chain.directEdges,
      topoOrder: dep.chain.chain.topoOrder,
      isDAG: dep.chain.chain.isDAG,
      nodeLabels: dep.chain.nodeLabels,
      nodeMeta: dep.chain.nodeMeta,
      insights: dep.insights,
    } : null,
  }), [data, dep]);


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
      const msg = e?.message ?? "Unknown error";
      toast.error(msg);
      setMessages((m) => [...m, { role: "assistant", content: "Sorry, I couldn't answer right now. " + msg }]);
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

const SHEET_KEY = "dependency.sheet.v1";
const LOGIC_KEY = "dependency.logic.v1";

function DependencyChainPanel() {
  const [sheetInput, setSheetInput] = useState("");
  const [savedSheet, setSavedSheet] = useState("");
  const [logicInput, setLogicInput] = useState(DEFAULT_LOGIC);

  useEffect(() => {
    try {
      const s = localStorage.getItem(SHEET_KEY);
      if (s) { setSheetInput(s); setSavedSheet(s); }
      const l = localStorage.getItem(LOGIC_KEY);
      if (l) setLogicInput(l);
    } catch {}
  }, []);

  const hasEmergent = /(^|[?&])d=eyJ/.test(logicInput) || /^eyJ/.test(logicInput.trim());
  const canResolve = !!savedSheet || hasEmergent;
  const inferFn = useServerFn(inferDependenciesEmergent);
  const { data: inferResult, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["dependency-infer", savedSheet, logicInput],
    queryFn: () => inferFn({ data: { appsScriptUrl: savedSheet, logic: logicInput } }),
    enabled: canResolve,
  });
  const data = inferResult?.ok ? inferResult.chain : undefined;
  const notConfigured = inferResult && !inferResult.ok;

  const insights = useMemo(() => computeInsights(data), [data]);

  // Push to shared store so Copilot can read live dependency context
  useEffect(() => {
    depStore.set({ chain: data ?? null, insights });
  }, [data, insights]);

  const resolve = () => {
    const v = sheetInput.trim();
    try {
      localStorage.setItem(SHEET_KEY, v);
      localStorage.setItem(LOGIC_KEY, logicInput);
    } catch {}
    setSavedSheet(v);
  };
  const resetLogic = () => setLogicInput(DEFAULT_LOGIC);

  return (
    <Card className="mt-8 border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FileSearch className="h-4 w-4 text-primary" />
            Dependency Chain
          </div>
          <div className="text-xs text-muted-foreground">
            Live mapping from your sheet, resolved via the JS logic below.
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => refetch()} disabled={!canResolve || isFetching}>
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <div className="mb-4 space-y-4">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Sheet URL (Apps Script web app or public JSON)
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={sheetInput}
              onChange={(e) => setSheetInput(e.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec  •  https://…/api/public/…"
              className="font-mono text-xs"
            />
            <Button size="sm" onClick={resolve} disabled={(!sheetInput.trim() && !hasEmergent) || isFetching}>
              {isFetching ? "Resolving…" : "Resolve"}
            </Button>
          </div>
        </div>

        {/* Neon VS Code-style editor */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Dependency Logic (paste from Emergent)
            </span>
            <button type="button" onClick={resetLogic} className="text-[10px] text-cyan-400 hover:underline">
              Reset to default
            </button>
          </div>
          <div
            className="overflow-hidden rounded-lg border border-cyan-500/40 bg-[#0b1020]"
            style={{ boxShadow: "0 0 0 1px rgba(34,211,238,0.25), 0 0 28px -6px rgba(34,211,238,0.45)" }}
          >
            <div className="flex items-center gap-2 border-b border-cyan-500/20 bg-[#080c1a] px-3 py-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
              <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-cyan-300/80">
                dependency-logic.js
              </span>
            </div>
            <Textarea
              value={logicInput}
              onChange={(e) => setLogicInput(e.target.value)}
              rows={12}
              spellCheck={false}
              className="rounded-none border-0 bg-transparent font-mono text-[12px] leading-relaxed text-cyan-100 placeholder:text-cyan-100/30 focus-visible:ring-0"
            />
          </div>
        </div>
      </div>

      {!canResolve && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          Paste an Apps Script URL above, or an Emergent resolver URL in the logic box below, then hit Resolve.
        </div>
      )}
      {isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Resolving chain…</div>}
      {error && <div className="py-8 text-center text-sm text-destructive">Failed: {String((error as Error).message)}</div>}
      {notConfigured && (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {(inferResult as any)?.message ?? "AI service isn't connected yet."}
        </div>
      )}

      {data && (
        <div className="space-y-5">
          <InsightCards insights={insights} />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Nodes" value={data.chain.stats.nodeCount} />
            <Stat label="Direct edges" value={data.chain.stats.directCount} />
            <Stat label="Skip edges" value={data.chain.stats.skipCount} />
            <Stat label="Transitive" value={data.chain.stats.transitiveEdgeCount} />
          </div>

          <div className="text-xs text-muted-foreground">
            DAG: <span className={data.chain.isDAG ? "text-emerald-500" : "text-destructive"}>{data.chain.isDAG ? "yes" : "cycle detected"}</span>
            {data.source && <> · Source rows: {data.source.rowIds.length} · Columns: {data.source.headers.length}</>}
          </div>

          <DependencyFlow activities={chainToActivities(data)} />
        </div>
      )}
    </Card>
  );
}

function computeInsights(data: DependencyChainResponse | undefined): DepSnapshot["insights"] {
  if (!data) return {};
  const t = data.chain.transitive;
  const meta = data.nodeMeta ?? {};
  const labels = data.nodeLabels ?? {};
  const labelOf = (id: string) => labels[id] || meta[id]?.task || id;

  // Top blocker
  let topBlocker: DepSnapshot["insights"]["topBlocker"];
  for (const [id, v] of Object.entries(t)) {
    const downstream = v.descendants.length;
    if (!topBlocker || downstream > topBlocker.downstream) {
      topBlocker = { id, label: labelOf(id), downstream };
    }
  }

  // Critical chain = longest path in DAG
  const order = data.chain.topoOrder;
  const adj = new Map<string, string[]>();
  for (const e of data.chain.directEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const n of order) { dist.set(n, 0); prev.set(n, null); }
  let bestEnd = order[0];
  for (const u of order) {
    const du = dist.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      if ((dist.get(v) ?? 0) < du + 1) {
        dist.set(v, du + 1);
        prev.set(v, u);
        if ((dist.get(v) ?? 0) > (dist.get(bestEnd) ?? 0)) bestEnd = v;
      }
    }
  }
  const critical: string[] = [];
  let cur: string | null = bestEnd;
  while (cur) { critical.unshift(labelOf(cur)); cur = prev.get(cur) ?? null; }

  // At-risk: any ancestor not done OR with delay>0
  const atRisk: string[] = [];
  for (const [id, v] of Object.entries(t)) {
    const risky = v.ancestors.some((a) => {
      const m = meta[a];
      if (!m) return false;
      const notDone = m.status && !/done|complet/i.test(m.status);
      return notDone || (m.delay ?? 0) > 0;
    });
    if (risky) atRisk.push(labelOf(id));
  }

  // Most delayed person
  const totals = new Map<string, number>();
  for (const m of Object.values(meta)) {
    if (!m.assignee) continue;
    totals.set(m.assignee, (totals.get(m.assignee) ?? 0) + (m.delay ?? 0));
  }
  let mostDelayedPerson: DepSnapshot["insights"]["mostDelayedPerson"];
  for (const [name, totalDelay] of totals) {
    if (!mostDelayedPerson || totalDelay > mostDelayedPerson.totalDelay) {
      mostDelayedPerson = { name, totalDelay };
    }
  }

  return { topBlocker, criticalChain: critical, atRisk: atRisk.slice(0, 5), mostDelayedPerson };
}

function InsightCards({ insights }: { insights: DepSnapshot["insights"] }) {
  const { topBlocker, criticalChain, atRisk, mostDelayedPerson } = insights;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <InsightCard
        title="Top Blocker"
        accent="text-amber-400"
        body={topBlocker ? `${topBlocker.label} blocks ${topBlocker.downstream} downstream task${topBlocker.downstream === 1 ? "" : "s"}.` : "—"}
      />
      <InsightCard
        title="Critical Chain"
        accent="text-cyan-400"
        body={criticalChain && criticalChain.length > 1 ? criticalChain.join(" → ") : "No multi-step path."}
      />
      <InsightCard
        title="At-Risk Tasks"
        accent="text-rose-400"
        body={atRisk && atRisk.length > 0 ? atRisk.join(", ") : "None detected."}
      />
      <InsightCard
        title="Most Delayed Person"
        accent="text-fuchsia-400"
        body={mostDelayedPerson && mostDelayedPerson.totalDelay > 0 ? `${mostDelayedPerson.name} · ${mostDelayedPerson.totalDelay}d total delay` : "—"}
      />
    </div>
  );
}

function InsightCard({ title, body, accent }: { title: string; body: string; accent: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className={`text-[10px] font-semibold uppercase tracking-wider ${accent}`}>{title}</div>
      <div className="mt-1 text-xs text-foreground">{body}</div>
    </div>
  );
}


function chainToActivities(data: DependencyChainResponse): Activity[] {
  const nodes = data.chain.nodes.length ? data.chain.nodes : (data.source?.rowIds ?? []);
  const idOf = new Map<string, number>();
  nodes.forEach((n: string, i: number) => idOf.set(n, i + 1));
  const parents = new Map<string, Set<string>>();
  data.chain.directEdges.forEach((e) => {
    if (!parents.has(e.to)) parents.set(e.to, new Set());
    parents.get(e.to)!.add(e.from);
  });
  return nodes.map((n: string) => ({
    uid: n,
    id: idOf.get(n)!,
    description: data.nodeLabels?.[n] || data.nodeMeta?.[n]?.task || n,
    stage: "",
    criticality: "Normal" as const,
    status: data.nodeMeta?.[n]?.status ?? "",
    assignee: data.nodeMeta?.[n]?.assignee,
    dependsOn: [...(parents.get(n) ?? [])].map((p) => idOf.get(p)!).filter(Boolean),
  }));
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
