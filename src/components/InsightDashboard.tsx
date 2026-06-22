import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { formatDistanceToNow, parseISO, isValid as isValidDate } from "date-fns";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Cell,
} from "recharts";
import {
  LayoutDashboard, Sheet as SheetIcon, MessageSquareWarning, Bell, Sparkles,
  Wand2, Send, ChevronDown, AlertTriangle, RefreshCcw, Link as LinkIcon,
  TrendingUp, Activity, CheckCircle2, Circle, CircleDot, Plus, ArrowRight,
} from "lucide-react";
import NotebookCopilot from "@/components/notebook/NotebookCopilot";

/* ============================== Types ============================== */
type Column = { name: string; type?: string };
type KPI = { label: string; value: number | string };
type ChartDef = { type?: string; title: string; x?: string; y?: string; data: { name: string; value: number }[] };
type Sheet = {
  label: string; name?: string; type?: string; color?: string;
  row_count?: number; columns?: Column[]; kpis?: KPI[]; charts?: ChartDef[];
  rows?: Record<string, unknown>[];
};
type Flag = { message?: string; title?: string; severity?: string };
type Analysis = {
  summary?: string;
  totals?: Record<string, number>;
  status_breakdown?: Record<string, number>;
  flags?: Flag[];
  mode_badge?: string;
  risk_score?: number | Record<string, unknown>;
  [k: string]: unknown;
};
type Modules = {
  data_quality?: { score?: number; issues?: unknown[] };
  digest?: string | { text?: string };
  recommendations?: (string | { title?: string; detail?: string })[];
  [k: string]: unknown;
};
type DashboardData = {
  project?: string;
  enabled_fields?: string[];
  multi_copilot?: boolean;
  sheets?: Sheet[];
  analysis?: Analysis;
  modules?: Modules;
  [k: string]: unknown;
};
type Concern = {
  id?: string; title?: string; detail?: string;
  severity?: "low" | "medium" | "high" | string;
  status?: "open" | "ack" | "acknowledged" | "resolved" | string;
  raised_by?: string; raised_by_department?: string;
  target_department?: string; target_person?: string;
  sheet_label?: string; activity_ref?: string; created_at?: string;
};
type ConcernsData = {
  enabled?: boolean;
  concerns?: Concern[];
  by_department?: Record<string, Record<string, number>>;
  message?: string;
};
type Reminder = {
  subject?: string; body?: string;
  recipient_email?: string;
  status?: "pending" | "sent" | "failed" | string;
  schedule_at?: string; recurrence?: "none" | "daily" | "weekly" | string;
  related_id?: string; related_type?: string;
};
type HarmonizeRow = {
  sheet_label?: string; column?: string; issue?: string;
  current: string; suggested: string;
};

/* ============================ Helpers ============================ */
const CHART_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const STATUS_COLOR: Record<string, string> = {
  open: "var(--chart-4)", pending: "var(--chart-3)", in_progress: "var(--chart-1)",
  ack: "var(--chart-3)", acknowledged: "var(--chart-3)",
  done: "var(--chart-2)", complete: "var(--chart-2)", completed: "var(--chart-2)", resolved: "var(--chart-2)",
  blocked: "var(--chart-4)", failed: "var(--chart-4)",
};

function fmtNum(v: unknown) {
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v).toLocaleString();
  return String(v ?? "");
}
function fmtCell(v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false;
}
function normalizeBase(raw: string): { base: string; error?: string } {
  let s = (raw || "").trim();
  if (!s) return { base: "", error: "Enter a full URL starting with https://" };
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/(dashboard|copilot|export|concerns|reminders|harmonize|column-map)\/?$/i, "");
  s = s.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(s)) return { base: "", error: "Enter a full URL starting with https://" };
  try { const u = new URL(s); if (!u.host) throw new Error(); } catch {
    return { base: "", error: "Enter a valid URL" };
  }
  return { base: s };
}
function relTime(iso?: string) {
  if (!iso) return "";
  const d = parseISO(iso);
  if (!isValidDate(d)) return iso;
  try { return formatDistanceToNow(d, { addSuffix: true }); } catch { return iso; }
}
function exactTime(iso?: string) {
  if (!iso) return "";
  const d = parseISO(iso);
  if (!isValidDate(d)) return iso;
  return d.toLocaleString();
}
function sevColor(sev?: string): "destructive" | "secondary" | "outline" | "default" {
  const s = (sev || "").toLowerCase();
  if (s === "high" || s === "critical") return "destructive";
  if (s === "medium" || s === "warn" || s === "warning") return "default";
  return "secondary";
}

/** Fetch helper. Throws NotFoundError on 404; throws Error on other failures. */
class NotFoundError extends Error {}
async function apiGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { credentials: "omit", signal });
  if (r.status === 404) throw new NotFoundError("404");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
async function apiSend<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, credentials: "omit",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) throw new NotFoundError("404");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  return ct.includes("application/json") ? ((await r.json()) as T) : (undefined as T);
}

/* ============================ Local URL state ============================ */
function useLinkInput() {
  const [raw, setRaw] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("link") || localStorage.getItem("insight:link") || "";
  });
  const [active, setActive] = useState<string>(() => {
    const r = (typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("link") || localStorage.getItem("insight:link"))) || "";
    return normalizeBase(r).base;
  });
  const [error, setError] = useState<string | undefined>();
  const apply = (val: string) => {
    const { base, error } = normalizeBase(val);
    if (error) { setError(error); setActive(""); return; }
    setError(undefined);
    setActive(base);
    try { localStorage.setItem("insight:link", val); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.set("link", val);
      window.history.replaceState({}, "", u.toString());
    }
  };
  return { raw, setRaw, active, error, apply };
}

/* ============================ Generic renderers ============================ */
function KVList({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  if (!entries.length) return null;
  return (
    <dl className="divide-y divide-border text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-3 py-1.5">
          <dt className="col-span-1 text-muted-foreground">{k}</dt>
          <dd className="col-span-2 break-words">
            {v == null ? <span className="text-muted-foreground">—</span>
              : typeof v === "object"
                ? <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>
                : fmtCell(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function ObjectArrayTable({ rows, maxRows = 200 }: { rows: Record<string, unknown>[]; maxRows?: number }) {
  const cols = useMemo(() => {
    const set = new Set<string>();
    rows.forEach(r => Object.keys(r || {}).forEach(k => set.add(k)));
    return Array.from(set);
  }, [rows]);
  return (
    <ScrollArea className="max-h-96 w-full">
      <Table>
        <TableHeader><TableRow>{cols.map(c => <TableHead key={c}>{c}</TableHead>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, maxRows).map((r, i) => (
            <TableRow key={i}>
              {cols.map(c => {
                const v = r?.[c];
                const isNum = typeof v === "number";
                return <TableCell key={c} className={`whitespace-nowrap ${isNum ? "tabular-nums text-right" : ""}`}>{fmtCell(v)}</TableCell>;
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
function GenericValue({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return <div className="text-sm">{fmtCell(value)}</div>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="text-sm text-muted-foreground">Empty</div>;
    if (value.every(isPlainObject)) return <ObjectArrayTable rows={value as Record<string, unknown>[]} />;
    return (
      <div className="flex flex-wrap gap-2">
        {value.map((v, i) => <Badge key={i} variant="secondary" className="font-normal">{fmtCell(v)}</Badge>)}
      </div>
    );
  }
  if (isPlainObject(value)) return <KVList obj={value} />;
  return null;
}

/* ============================ Pieces ============================ */
function SectionEmpty({ icon: Icon = Circle, label }: { icon?: any; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
      <Icon className="h-6 w-6 opacity-50" />
      <div className="text-sm">{label}</div>
    </div>
  );
}
function SectionError({ message }: { message: string }) {
  return (
    <Card className="rounded-2xl border-destructive/30">
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
        <div>
          <div className="font-medium">Couldn't load this section</div>
          <div className="text-muted-foreground">{message}. The source API may be unreachable or protected.</div>
        </div>
      </CardContent>
    </Card>
  );
}
function CardSkeleton({ h = 24 }: { h?: number }) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-3 p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="w-full" style={{ height: `${h * 4}px` }} />
      </CardContent>
    </Card>
  );
}
function HeroKpi({ label, value, color }: { label: string; value: unknown; color: string }) {
  return (
    <Card className="relative overflow-hidden rounded-2xl shadow-sm">
      <div className="absolute inset-x-0 top-0 h-1" style={{ background: color }} />
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
          <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="mt-2 text-3xl font-semibold tabular-nums">{fmtNum(value)}</div>
      </CardContent>
    </Card>
  );
}
function StackedBar({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((s, [, v]) => s + Number(v), 0) || 1;
  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {entries.map(([k, v], i) => (
          <div key={k} style={{ width: `${(Number(v) / total) * 100}%`, background: STATUS_COLOR[k.toLowerCase()] || CHART_COLORS[i % CHART_COLORS.length] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map(([k, v], i) => (
          <Badge key={k} variant="outline" className="gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k.toLowerCase()] || CHART_COLORS[i % CHART_COLORS.length] }} />
            <span>{k}</span><span className="tabular-nums text-muted-foreground">{fmtNum(v)}</span>
          </Badge>
        ))}
      </div>
    </div>
  );
}
function MiniBarChart({ data, color = "var(--chart-1)" }: { data: { name: string; value: number }[]; color?: string }) {
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? "end" : "middle"} height={data.length > 6 ? 50 : 30} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]}>
            {data.map((_, i) => <Cell key={i} fill={color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
function Gauge({ value, max = 100, label }: { value: number; max?: number; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const hue = pct < 33 ? "var(--chart-2)" : pct < 66 ? "var(--chart-3)" : "var(--chart-4)";
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-3xl font-semibold tabular-nums">{fmtNum(value)}</div>
        <div className="text-xs text-muted-foreground">/ {max}</div>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded bg-muted">
        <div className="h-full transition-all" style={{ width: `${pct}%`, background: hue }} />
      </div>
    </div>
  );
}
function Ring({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 28, c = 2 * Math.PI * r;
  const off = c - (pct / 100) * c;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 80 80" className="h-20 w-20">
        <circle cx="40" cy="40" r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--chart-2)" strokeWidth="8" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 40 40)" />
        <text x="40" y="45" textAnchor="middle" className="fill-foreground" style={{ fontSize: 14, fontWeight: 600 }}>{Math.round(pct)}</text>
      </svg>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-sm">Quality score</div>
      </div>
    </div>
  );
}

/* ============================ Sections ============================ */

function OverviewSection({ data }: { data: DashboardData }) {
  const a = data.analysis || {};
  const m = data.modules || {};
  const totals = a.totals || {};
  const sb = a.status_breakdown || {};
  const flags = (a.flags || []).filter(Boolean);

  const extraAnalysis = Object.entries(a).filter(([k, v]) =>
    !["summary", "totals", "status_breakdown", "flags", "mode_badge"].includes(k) && !isEmpty(v));
  const extraModules = Object.entries(m).filter(([k, v]) =>
    !["data_quality", "digest", "recommendations", "risk_score"].includes(k) && !isEmpty(v));

  return (
    <div className="space-y-6">
      {/* KPI tiles */}
      {!isEmpty(totals) && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Object.entries(totals).map(([k, v], i) => (
            <HeroKpi key={k} label={k.replace(/_/g, " ")} value={v} color={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </div>
      )}

      {/* Summary callout */}
      {!isEmpty(a.summary) && (
        <Card className="rounded-2xl border-l-4 shadow-sm" style={{ borderLeftColor: "var(--chart-1)" }}>
          <CardContent className="flex gap-3 p-4 text-sm leading-relaxed">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p>{a.summary}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Status breakdown */}
        {!isEmpty(sb) && (
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Status breakdown</CardTitle></CardHeader>
            <CardContent><StackedBar data={sb as Record<string, number>} /></CardContent>
          </Card>
        )}
        {/* Flags */}
        {flags.length > 0 && (
          <Card className="rounded-2xl shadow-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Flags</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {flags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <Badge variant={sevColor(f.severity)} className="shrink-0 capitalize">{f.severity || "info"}</Badge>
                    <span>{f.message || f.title || ""}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Modules grid */}
      {(m.digest || m.recommendations || a.risk_score != null || m.data_quality) && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {a.risk_score != null && (
            <Card className="rounded-2xl shadow-sm"><CardContent className="p-4">
              <Gauge label="Risk score" value={typeof a.risk_score === "number" ? a.risk_score : Number((a.risk_score as any)?.score) || 0} />
            </CardContent></Card>
          )}
          {m.data_quality?.score != null && (
            <Card className="rounded-2xl shadow-sm"><CardContent className="p-4">
              <Ring label="Data quality" value={Number(m.data_quality.score)} />
              {!!m.data_quality.issues?.length && (
                <div className="mt-2 text-xs text-muted-foreground">{m.data_quality.issues.length} issue(s)</div>
              )}
            </CardContent></Card>
          )}
          {m.digest && (
            <Card className="rounded-2xl shadow-sm md:col-span-2"><CardHeader className="pb-2"><CardTitle className="text-sm">Digest</CardTitle></CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {typeof m.digest === "string" ? m.digest : (m.digest as any).text}
              </CardContent>
            </Card>
          )}
          {!!m.recommendations?.length && (
            <Card className="rounded-2xl shadow-sm md:col-span-2 xl:col-span-4"><CardHeader className="pb-2"><CardTitle className="text-sm">Recommendations</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {m.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      <span>{typeof r === "string" ? r : (r.title ? <><strong>{r.title}</strong> — {r.detail}</> : r.detail)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {(extraAnalysis.length > 0 || extraModules.length > 0) && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground"><ChevronDown className="h-4 w-4" /> More analytics</Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-4">
            {extraAnalysis.map(([k, v]) => (
              <Card key={`a-${k}`} className="rounded-2xl"><CardHeader className="pb-2"><CardTitle className="text-sm capitalize">{k.replace(/_/g, " ")}</CardTitle></CardHeader><CardContent><GenericValue value={v} /></CardContent></Card>
            ))}
            {extraModules.map(([k, v]) => (
              <Card key={`m-${k}`} className="rounded-2xl"><CardHeader className="pb-2"><CardTitle className="text-sm capitalize">{k.replace(/_/g, " ")}</CardTitle></CardHeader><CardContent><GenericValue value={v} /></CardContent></Card>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function SheetsSection({ sheets }: { sheets: Sheet[] }) {
  const [active, setActive] = useState(sheets[0]?.label || "");
  useEffect(() => { if (!sheets.find(s => s.label === active)) setActive(sheets[0]?.label || ""); }, [sheets, active]);
  if (!sheets.length) return <SectionEmpty icon={SheetIcon} label="No sheets returned." />;
  const sheet = sheets.find(s => s.label === active) || sheets[0];
  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <div className="flex flex-wrap gap-2">
          {sheets.map(s => (
            <button key={s.label} onClick={() => setActive(s.label)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${active === s.label ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}>
              <span className="font-medium">{s.label}</span>
              {s.type && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{s.type}</Badge>}
              {s.row_count != null && <span className="tabular-nums opacity-70">{fmtNum(s.row_count)}</span>}
            </button>
          ))}
        </div>
      </div>

      {!!sheet.kpis?.length && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {sheet.kpis.map((k, i) => (
            <HeroKpi key={i} label={k.label} value={k.value} color={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </div>
      )}

      {!!sheet.charts?.length && (
        <div className="grid gap-4 md:grid-cols-2">
          {sheet.charts.map((c, i) => (
            <Card key={i} className="rounded-2xl shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-sm">{c.title}</CardTitle></CardHeader>
              <CardContent><MiniBarChart data={c.data || []} color={CHART_COLORS[i % CHART_COLORS.length]} /></CardContent>
            </Card>
          ))}
        </div>
      )}

      {!!sheet.rows?.length && !!sheet.columns?.length && (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm">{sheet.name || sheet.label}</CardTitle>
            <span className="text-xs text-muted-foreground">{fmtNum(sheet.rows.length)} rows shown</span>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[28rem] w-full">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    {sheet.columns.map(c => <TableHead key={c.name} className={c.type === "number" ? "text-right" : ""}>{c.name}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sheet.rows.slice(0, 500).map((r, i) => {
                    const lab = String(r["status"] || r["type"] || "").toLowerCase();
                    const muted = /total|subtotal|grand/.test(lab) || /total|subtotal|grand/i.test(JSON.stringify(r).slice(0, 100));
                    return (
                      <TableRow key={i} className={`${i % 2 ? "bg-muted/30" : ""} ${muted ? "text-muted-foreground italic" : ""}`}>
                        {sheet.columns!.map(c => {
                          const v = r[c.name];
                          const txt = fmtCell(v);
                          const long = txt.length > 40;
                          return (
                            <TableCell key={c.name} className={`whitespace-nowrap ${c.type === "number" ? "tabular-nums text-right" : ""}`}>
                              {long ? (
                                <TooltipProvider><UITooltip><TooltipTrigger asChild><span className="cursor-default">{txt.slice(0, 40)}…</span></TooltipTrigger><TooltipContent className="max-w-sm break-words">{txt}</TooltipContent></UITooltip></TooltipProvider>
                              ) : txt}
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ConcernsSection({ base, sheets, onRemind }: { base: string; sheets: Sheet[]; onRemind: (c: Concern) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["concerns", base],
    queryFn: ({ signal }) => apiGet<ConcernsData>(`${base}/concerns`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
  const patchStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiSend(`${base}/concerns/${encodeURIComponent(id)}`, "PATCH", { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: ["concerns", base] });
      const prev = qc.getQueryData<ConcernsData>(["concerns", base]);
      if (prev?.concerns) {
        qc.setQueryData<ConcernsData>(["concerns", base], {
          ...prev, concerns: prev.concerns.map(c => c.id === id ? { ...c, status } : c),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["concerns", base], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ["concerns", base] }),
  });

  if (q.isPending) return <div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} h={32} />)}</div>;
  if (q.error instanceof NotFoundError) return null;
  if (q.error) return <SectionError message={(q.error as Error).message} />;

  const data = q.data || {};
  if (data.enabled === false) return null;
  const concerns = data.concerns || [];
  const byDept = data.by_department || {};
  const depts = Object.keys(byDept).length
    ? Object.keys(byDept)
    : Array.from(new Set(concerns.map(c => c.target_department).filter(Boolean) as string[]));

  if (!depts.length && !concerns.length) {
    return (
      <div className="space-y-4">
        <RaiseConcernButton base={base} sheets={sheets} />
        <SectionEmpty icon={MessageSquareWarning} label="No concerns yet." />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{concerns.length} concern(s) across {depts.length} department(s)</p>
        <RaiseConcernButton base={base} sheets={sheets} />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {depts.map(dept => {
          const counts = byDept[dept] || {};
          const items = concerns.filter(c => c.target_department === dept);
          return (
            <Card key={dept} className="rounded-2xl shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{dept}</span>
                  {Object.entries(counts).map(([k, v]) => (
                    <Badge key={k} variant="outline" className="font-normal capitalize">{k}: <span className="ml-1 tabular-nums">{v as number}</span></Badge>
                  ))}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {items.length === 0 && <div className="text-xs text-muted-foreground">No items</div>}
                {items.map((c, idx) => {
                  const key = c.id || `${dept}-${c.activity_ref || ""}-${c.created_at || idx}`;
                  const editable = !!c.id;
                  return (
                    <div key={key} className="rounded-xl border border-border bg-card p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium leading-snug">{c.title || "(untitled)"}</div>
                        <Badge variant={sevColor(c.severity)} className="capitalize">{c.severity || "low"}</Badge>
                      </div>
                      {c.detail && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.detail}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {c.raised_by && <Badge variant="secondary" className="font-normal">{c.raised_by}</Badge>}
                        {c.target_department && <ArrowRight className="h-3 w-3" />}
                        {c.target_department && <Badge variant="secondary" className="font-normal">{c.target_department}</Badge>}
                        {c.activity_ref && <span className="ml-auto truncate">ref: {c.activity_ref}</span>}
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <UITimeAgo iso={c.created_at} />
                        <div className="flex gap-1.5">
                          <TooltipProvider>
                            {c.status !== "ack" && c.status !== "acknowledged" && c.status !== "resolved" && (
                              <UITooltip>
                                <TooltipTrigger asChild>
                                  <span><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!editable} onClick={() => editable && patchStatus.mutate({ id: c.id!, status: "ack" })}>Ack</Button></span>
                                </TooltipTrigger>
                                {!editable && <TooltipContent>Read-only demo item</TooltipContent>}
                              </UITooltip>
                            )}
                            {c.status !== "resolved" && (
                              <UITooltip>
                                <TooltipTrigger asChild>
                                  <span><Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={!editable} onClick={() => editable && patchStatus.mutate({ id: c.id!, status: "resolved" })}>Resolve</Button></span>
                                </TooltipTrigger>
                                {!editable && <TooltipContent>Read-only demo item</TooltipContent>}
                              </UITooltip>
                            )}
                          </TooltipProvider>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onRemind(c)}>Remind</Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function UITimeAgo({ iso }: { iso?: string }) {
  if (!iso) return <span className="text-[11px] text-muted-foreground">—</span>;
  return (
    <TooltipProvider><UITooltip>
      <TooltipTrigger asChild><span className="cursor-default text-[11px] text-muted-foreground">{relTime(iso)}</span></TooltipTrigger>
      <TooltipContent>{exactTime(iso)}</TooltipContent>
    </UITooltip></TooltipProvider>
  );
}

type ColumnMap = Record<string, { owner?: string | null; dept?: string | null; email?: string | null; status?: string | null; date?: string | null } | unknown>;

function useColumnMap(base: string, enabled: boolean) {
  return useQuery({
    queryKey: ["column-map", base], enabled,
    queryFn: ({ signal }) => apiGet<ColumnMap & { enabled?: boolean }>(`${base}/column-map`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
}

function deptValuesForSheet(cm: ColumnMap | undefined, sheet?: Sheet): string[] {
  if (!sheet) return [];
  const m = cm?.[sheet.label] as { dept?: string | null } | undefined;
  const col = m?.dept;
  const set = new Set<string>();
  if (col && sheet.rows) {
    sheet.rows.forEach(r => {
      const v = r[col]; if (typeof v === "string" && v.trim()) set.add(v.trim());
    });
  }
  if (set.size === 0 && sheet.rows) sheet.rows.forEach(r => {
    const v = r["department"] || r["Department"] || r["dept"];
    if (typeof v === "string" && v.trim()) set.add(v.trim());
  });
  return Array.from(set);
}

function emailForDept(cm: ColumnMap | undefined, sheet: Sheet | undefined, dept: string): string | undefined {
  if (!sheet || !dept) return undefined;
  const m = cm?.[sheet.label] as { dept?: string | null; email?: string | null } | undefined;
  const deptCol = m?.dept; const emailCol = m?.email;
  if (!deptCol || !emailCol || !sheet.rows) return undefined;
  const row = sheet.rows.find(r => String(r[deptCol] || "").trim() === dept);
  const v = row?.[emailCol];
  return typeof v === "string" ? v : undefined;
}

function RaiseConcernButton({ base, sheets, prefill }: { base: string; sheets: Sheet[]; prefill?: Partial<Concern> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [sheetLabel, setSheetLabel] = useState(prefill?.sheet_label || sheets[0]?.label || "");
  const [targetDept, setTargetDept] = useState(prefill?.target_department || "");
  const [raisedBy, setRaisedBy] = useState(prefill?.raised_by || "");
  const [raisedByDept, setRaisedByDept] = useState(prefill?.raised_by_department || "");
  const [title, setTitle] = useState(prefill?.title || "");
  const [detail, setDetail] = useState(prefill?.detail || "");
  const [severity, setSeverity] = useState<string>(prefill?.severity || "medium");
  const [activityRef, setActivityRef] = useState(prefill?.activity_ref || "");

  const colMap = useColumnMap(base, open);
  const currentSheet = sheets.find(s => s.label === sheetLabel);
  const deptOptions = useMemo(() => {
    const set = new Set<string>();
    sheets.forEach(s => deptValuesForSheet(colMap.data, s).forEach(v => set.add(v)));
    return Array.from(set);
  }, [colMap.data, sheets]);

  const activityOptions = useMemo(() => {
    if (!currentSheet?.rows) return [] as { value: string; label: string }[];
    const cols = (currentSheet.columns || []).map(c => c.name);
    const schKey = cols.find(c => /sch\s*code|^sch$|activity\s*ref/i.test(c));
    const descKey = cols.find(c => /description|desc|activity/i.test(c));
    if (!schKey) return [];
    return currentSheet.rows.slice(0, 500).map(r => {
      const v = String(r[schKey] ?? "");
      const d = descKey ? String(r[descKey] ?? "") : "";
      return { value: v, label: d ? `${v} — ${d.slice(0, 60)}` : v };
    }).filter(o => o.value);
  }, [currentSheet]);

  const create = useMutation({
    mutationFn: (payload: Partial<Concern>) => apiSend<Concern>(`${base}/concerns`, "POST", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["concerns", base] });
      setOpen(false);
      setTitle(""); setDetail(""); setActivityRef("");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5"><Plus className="h-4 w-4" /> Raise concern</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Raise a concern</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Sheet</label>
              <Select value={sheetLabel} onValueChange={setSheetLabel}>
                <SelectTrigger><SelectValue placeholder="Sheet" /></SelectTrigger>
                <SelectContent>{sheets.map(s => <SelectItem key={s.label} value={s.label}>{s.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Target department</label>
              {deptOptions.length ? (
                <Select value={targetDept} onValueChange={setTargetDept}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{deptOptions.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <Input value={targetDept} onChange={e => setTargetDept(e.target.value)} placeholder="e.g. Cabling" />
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Raised by</label>
              <Input value={raisedBy} onChange={e => setRaisedBy(e.target.value)} placeholder="Your name" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Raised by dept</label>
              <Input value={raisedByDept} onChange={e => setRaisedByDept(e.target.value)} placeholder="Your dept" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Title</label>
            <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Short summary" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Detail</label>
            <Textarea value={detail} onChange={e => setDetail(e.target.value)} placeholder="What's happening?" rows={3} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Severity</label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Activity ref</label>
              {activityOptions.length ? (
                <Select value={activityRef} onValueChange={setActivityRef}>
                  <SelectTrigger><SelectValue placeholder="Pick activity" /></SelectTrigger>
                  <SelectContent>{activityOptions.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <Input value={activityRef} onChange={e => setActivityRef(e.target.value)} placeholder="row ref (optional)" />
              )}
            </div>
          </div>
          {create.error && <p className="text-xs text-destructive">Failed: {(create.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!title || !targetDept || create.isPending}
            onClick={() => create.mutate({
              raised_by: raisedBy || undefined,
              raised_by_department: raisedByDept || undefined,
              target_department: targetDept,
              sheet_label: sheetLabel || undefined,
              activity_ref: activityRef || undefined,
              title, detail, severity,
            })}>
            {create.isPending ? "Submitting…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReminderDialog({ open, onOpenChange, base, prefill }: {
  open: boolean; onOpenChange: (o: boolean) => void; base: string;
  prefill?: { related_id?: string; recipient_email?: string; subject?: string; body?: string; recurrence?: string };
}) {
  const qc = useQueryClient();
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recurrence, setRecurrence] = useState<string>("none");
  const [scheduleAt, setScheduleAt] = useState<string>("");
  const [relatedId, setRelatedId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    setRecipient(prefill?.recipient_email || "");
    setSubject(prefill?.subject || "");
    setBody(prefill?.body || "");
    setRecurrence(prefill?.recurrence || "none");
    setScheduleAt("");
    setRelatedId(prefill?.related_id || "");
  }, [open, prefill]);

  const create = useMutation({
    mutationFn: () => apiSend(`${base}/reminders`, "POST", {
      related_type: "concern",
      related_id: relatedId || undefined,
      recipient_email: recipient,
      subject, body,
      schedule_at: scheduleAt ? new Date(scheduleAt).toISOString() : undefined,
      recurrence,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reminders", base] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{prefill?.related_id ? "Send reminder" : "New reminder"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Recipient email</label>
            <Input type="email" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="name@example.com" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Subject</label>
            <Input value={subject} onChange={e => setSubject(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Body</label>
            <Textarea value={body} onChange={e => setBody(e.target.value)} rows={4} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Recurrence</label>
              <Select value={recurrence} onValueChange={setRecurrence}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Schedule (optional)</label>
              <Input type="datetime-local" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} />
            </div>
          </div>
          {create.error && <p className="text-xs text-destructive">Failed: {(create.error as Error).message}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!recipient || !subject || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemindersSection({ base, onNew }: { base: string; onNew: () => void }) {
  const q = useQuery({
    queryKey: ["reminders", base],
    queryFn: ({ signal }) => apiGet<{ enabled?: boolean; reminders?: Reminder[] }>(`${base}/reminders`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
  if (q.isPending) return <CardSkeleton h={40} />;
  if (q.error instanceof NotFoundError) return null;
  if (q.error) return <SectionError message={(q.error as Error).message} />;
  if (q.data?.enabled === false) return null;

  const list = q.data?.reminders || [];
  const groups = { pending: [] as Reminder[], sent: [] as Reminder[], failed: [] as Reminder[] };
  list.forEach(r => {
    const k = (r.status || "pending").toLowerCase() as keyof typeof groups;
    (groups[k] || groups.pending).push(r);
  });
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs italic text-muted-foreground">Emails are sent automatically by the server.</p>
        <Button size="sm" className="gap-1.5" onClick={onNew}><Plus className="h-4 w-4" /> New reminder</Button>
      </div>
      {list.length === 0 && <SectionEmpty icon={Bell} label="No reminders configured." />}
      {(["pending", "sent", "failed"] as const).map(k => groups[k].length > 0 && (
        <Card key={k} className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm capitalize flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k] || "var(--chart-1)" }} />
            {k} <span className="text-muted-foreground tabular-nums">({groups[k].length})</span>
          </CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Recipient</TableHead><TableHead>Subject</TableHead><TableHead>Schedule</TableHead><TableHead>Recurrence</TableHead></TableRow></TableHeader>
              <TableBody>
                {groups[k].map((r, i) => (
                  <TableRow key={`${r.related_id || ""}-${r.recipient_email || ""}-${i}`}>
                    <TableCell className="text-sm">{r.recipient_email || "—"}</TableCell>
                    <TableCell className="max-w-xs truncate">{r.subject || "—"}</TableCell>
                    <TableCell><UITimeAgo iso={r.schedule_at} /></TableCell>
                    <TableCell>{r.recurrence && r.recurrence !== "none" ? <Badge variant="outline" className="capitalize">{r.recurrence}</Badge> : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CopilotSection({ base, sheets, multi }: { base: string; sheets: Sheet[]; multi: boolean }) {
  const [selected, setSelected] = useState(sheets[0]?.label || "");
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; generated_by?: string }[]>([]);
  const [input, setInput] = useState("");
  const sessionId = useRef<string | undefined>(undefined);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMessages([]); sessionId.current = undefined; }, [base, selected, multi]);
  useEffect(() => { scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);

  const ask = useMutation({
    mutationFn: async (message: string) => {
      const body: any = { message };
      if (sessionId.current) body.session_id = sessionId.current;
      if (multi) body.sheets = sheets.map(s => s.label);
      const url = multi ? `${base}/copilot` : `${base}/copilot?sheet=${encodeURIComponent(selected)}`;
      return apiSend<any>(url, "POST", body);
    },
    onSuccess: (resp) => {
      if (resp?.session_id) sessionId.current = resp.session_id;
      const text = resp?.answer || (typeof resp === "string" ? resp : JSON.stringify(resp));
      setMessages(m => [...m, { role: "assistant", text, generated_by: resp?.generated_by }]);
    },
    onError: (e) => setMessages(m => [...m, { role: "assistant", text: `Error: ${(e as Error).message}` }]),
  });

  const send = (q: string) => {
    const text = q.trim();
    if (!text) return;
    setMessages(m => [...m, { role: "user", text }]);
    setInput("");
    ask.mutate(text);
  };

  const chips = ["Where are we slipping?", "Top concerns by department", "Cross-sheet summary", "Which items are missing owners?"];

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-primary" /> Copilot</CardTitle>
        {!multi && sheets.length > 1 && (
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Select sheet" /></SelectTrigger>
            <SelectContent>{sheets.map(s => <SelectItem key={s.label} value={s.label}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {multi && <Badge variant="outline">multi-sheet</Badge>}
      </CardHeader>
      <CardContent>
        <div ref={scrollerRef} className="mb-3 max-h-[28rem] min-h-[14rem] space-y-3 overflow-y-auto rounded-xl bg-muted/30 p-3">
          {messages.length === 0 && (
            <div className="text-center text-xs text-muted-foreground">Ask anything about your data.</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card"}`}>
                <div className="whitespace-pre-wrap">{m.text}</div>
                {m.generated_by && (
                  <div className="mt-1.5"><Badge variant="secondary" className="text-[10px] font-normal capitalize">{m.generated_by}</Badge></div>
                )}
              </div>
            </div>
          ))}
          {ask.isPending && (
            <div className="flex justify-start"><div className="rounded-2xl bg-card px-3 py-2 text-sm shadow-sm text-muted-foreground">Thinking<span className="inline-block w-6 animate-pulse">…</span></div></div>
          )}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map(c => (
            <button key={c} onClick={() => send(c)} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground" disabled={ask.isPending}>{c}</button>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); send(input); }} className="flex gap-2">
          <Input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask the copilot…" disabled={ask.isPending} />
          <Button type="submit" disabled={ask.isPending || !input.trim()}><Send className="h-4 w-4" /></Button>
        </form>
      </CardContent>
    </Card>
  );
}

function HygieneSection({ base }: { base: string }) {
  const q = useQuery({
    queryKey: ["harmonize", base],
    queryFn: ({ signal }) => apiGet<{ enabled?: boolean; suggestions?: HarmonizeRow[]; message?: string } | HarmonizeRow[]>(`${base}/harmonize`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
  if (q.isPending) return <CardSkeleton h={40} />;
  if (q.error instanceof NotFoundError) return null;
  if (q.error) return <SectionError message={(q.error as Error).message} />;
  const data = q.data as any;
  if (data?.enabled === false) return null;
  const rows: HarmonizeRow[] = Array.isArray(data) ? data : (data?.suggestions || []);
  const message: string | undefined = !Array.isArray(data) ? data?.message : undefined;

  if (!rows.length) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground">
          <Wand2 className="h-6 w-6 opacity-50" />
          <div className="text-sm">{message || "No hygiene suggestions."}</div>
        </CardContent>
      </Card>
    );
  }

  const bySheet = rows.reduce<Record<string, HarmonizeRow[]>>((acc, r) => {
    const k = r.sheet_label || "default"; (acc[k] ||= []).push(r); return acc;
  }, {});
  return (
    <div className="space-y-4">
      {Object.entries(bySheet).map(([sheet, list]) => (
        <Card key={sheet} className="rounded-2xl shadow-sm">
          <CardHeader className="pb-2"><CardTitle className="text-sm">{sheet}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Column</TableHead><TableHead>Current</TableHead><TableHead></TableHead><TableHead>Suggested</TableHead></TableRow></TableHeader>
              <TableBody>
                {list.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs text-muted-foreground">{r.column || "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.current}
                      {r.issue && <div className="mt-0.5 text-[11px] font-sans italic text-muted-foreground">{r.issue}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground"><ArrowRight className="h-4 w-4" /></TableCell>
                    <TableCell className="font-mono text-xs">{r.suggested}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ============================ Notebook Co-pilot tab wrapper ============================ */
function NotebookCopilotTab({ base, sheets, setTab }: { base: string; sheets: Sheet[]; setTab: (t: typeof TABS[number]["id"]) => void }) {
  const cq = useQuery({
    queryKey: ["concerns", base],
    queryFn: ({ signal }) => apiGet<ConcernsData>(`${base}/concerns`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
  const rq = useQuery({
    queryKey: ["reminders", base],
    queryFn: ({ signal }) => apiGet<{ enabled?: boolean; reminders?: Reminder[] }>(`${base}/reminders`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });
  const concerns = (cq.data?.enabled !== false ? cq.data?.concerns : []) ?? [];
  const reminders = (rq.data?.enabled !== false ? rq.data?.reminders : []) ?? [];
  return (
    <NotebookCopilot
      base={base}
      sheets={sheets}
      concerns={concerns}
      reminders={reminders.map((r, i) => ({ ...r, id: (r as { id?: string }).id ?? `idx${i}` }))}
      onJumpToSheetRow={(sheet, row) => {
        setTab("sheets");
        setTimeout(() => {
          const el = document.querySelector(`[data-sheet="${CSS.escape(sheet)}"][data-row="${row}"]`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("ring-2", "ring-primary");
            setTimeout(() => el.classList.remove("ring-2", "ring-primary"), 2500);
          }
        }, 200);
      }}
      onOpenConcern={() => setTab("concerns")}
    />
  );
}



const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "sheets", label: "Sheets", icon: SheetIcon },
  { id: "concerns", label: "Concerns", icon: MessageSquareWarning },
  { id: "reminders", label: "Reminders", icon: Bell },
  { id: "copilot", label: "Copilot", icon: Sparkles },
  { id: "hygiene", label: "Data Hygiene", icon: Wand2 },
] as const;

export default function InsightDashboard() {
  const { raw, setRaw, active, error, apply } = useLinkInput();
  const [tab, setTab] = useState<typeof TABS[number]["id"]>("overview");
  const [reminderOpen, setReminderOpen] = useState(false);
  const [reminderPrefill, setReminderPrefill] = useState<{ related_id?: string; recipient_email?: string; subject?: string; body?: string; recurrence?: string } | undefined>();

  const dq = useQuery({
    queryKey: ["dashboard", active], enabled: !!active,
    queryFn: ({ signal }) => apiGet<DashboardData>(`${active}/dashboard`, signal),
    placeholderData: keepPreviousData,
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });

  const data = dq.data || {};
  const sheets = data.sheets || [];
  const project = data.project || "Insights";
  const modeBadge = data.analysis?.mode_badge;
  const enabledFields = data.enabled_fields || [];
  const multiCopilot = enabledFields.includes("multi_copilot") || !!data.multi_copilot;

  const colMapQ = useQuery({
    queryKey: ["column-map", active], enabled: !!active,
    queryFn: ({ signal }) => apiGet<ColumnMap>(`${active}/column-map`, signal),
    retry: (n, e) => !(e instanceof NotFoundError) && n < 1,
  });

  const openRemind = (c: Concern) => {
    const sheet = sheets.find(s => s.label === c.sheet_label);
    const recipient = c.target_department ? emailForDept(colMapQ.data, sheet, c.target_department) : undefined;
    setReminderPrefill({
      related_id: c.id,
      subject: c.title ? `Action needed: ${c.title}` : "Reminder",
      body: c.detail || "",
      recipient_email: recipient,
      recurrence: "none",
    });
    setReminderOpen(true);
  };

  const reloadAll = () => dq.refetch();

  return (
    <div className="space-y-4">
      {/* Sticky header */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary"><Activity className="h-4 w-4" /></div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{project}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {modeBadge && <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">{modeBadge}</Badge>}
                <span className="truncate">{active || "no link"}</span>
              </div>
            </div>
          </div>
          <form onSubmit={e => { e.preventDefault(); apply(raw); }} className="flex flex-1 items-center gap-2 md:max-w-2xl md:ml-auto">
            <div className="relative flex-1">
              <LinkIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={raw} onChange={e => setRaw(e.target.value)} placeholder="https://host/api/public/<token>" className="pl-8" />
            </div>
            <Button type="submit" size="sm">Load</Button>
            <Button type="button" size="sm" variant="outline" onClick={reloadAll} disabled={!active || dq.isFetching}>
              <RefreshCcw className={`h-4 w-4 ${dq.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <SectionError message={error} />}

      {!active && !error && (
        <Card className="rounded-2xl"><CardContent className="p-10 text-center text-sm text-muted-foreground">
          Paste a DelayBridge link above to load your insights.
        </CardContent></Card>
      )}

      {active && (
        <>
          {dq.error instanceof NotFoundError && <SectionError message="Dashboard endpoint not found at this URL" />}
          {dq.error && !(dq.error instanceof NotFoundError) && <SectionError message={(dq.error as Error).message} />}

          {/* Mobile select */}
          <div className="md:hidden">
            <Select value={tab} onValueChange={(v) => setTab(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TABS.map(t => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
            {/* Tab rail */}
            <aside className="hidden md:block">
              <nav className="space-y-1 rounded-2xl border border-border bg-card p-2">
                {TABS.map(t => {
                  const Icon = t.icon;
                  const isActive = tab === t.id;
                  return (
                    <button key={t.id} onClick={() => setTab(t.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}>
                      <Icon className="h-4 w-4" /> {t.label}
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* Content */}
            <div className="min-w-0 space-y-4">
              {dq.isPending && (
                <div className="grid gap-3 md:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
                </div>
              )}

              {!dq.isPending && tab === "overview" && <OverviewSection data={data} />}
              {!dq.isPending && tab === "sheets" && <SheetsSection sheets={sheets} />}
              {!dq.isPending && tab === "concerns" && active && <ConcernsSection base={active} sheets={sheets} onRemind={openRemind} />}
              {!dq.isPending && tab === "reminders" && active && <RemindersSection base={active} onNew={() => { setReminderPrefill(undefined); setReminderOpen(true); }} />}
              {!dq.isPending && tab === "copilot" && active && <NotebookCopilotTab base={active} sheets={sheets} setTab={setTab} />}
              {!dq.isPending && tab === "hygiene" && active && <HygieneSection base={active} />}
            </div>
          </div>

          <ReminderDialog open={reminderOpen} onOpenChange={setReminderOpen} base={active} prefill={reminderPrefill} />
        </>
      )}
    </div>
  );
}
