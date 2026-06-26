import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  Download, Filter as FilterIcon, X as XIcon, Search as SearchIcon,
} from "lucide-react";
import NotebookCopilot from "@/components/notebook/NotebookCopilot";
import { generateGemini, hasGemini, GROUNDING_RULES } from "@/lib/gemini-client";

/* ============================== Types ============================== */
type Column = { name: string; type?: string; distinct?: number };
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
  ai_summary?: string;
  ai_summary_generated_by?: string;
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
  const clear = () => {
    setRaw("");
    setActive("");
    setError(undefined);
    try { localStorage.removeItem("insight:link"); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("link");
      window.history.replaceState({}, "", u.toString());
    }
  };
  return { raw, setRaw, active, error, apply, clear };
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
          <dd className="col-span-2 min-w-0 break-words">
            {v == null
              ? <span className="text-muted-foreground">—</span>
              : typeof v === "object"
                ? <GenericValue value={v} />
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
function Sparkline({ tone = "default" }: { tone?: "default" | "light" | "dark" }) {
  const stroke =
    tone === "light" ? "rgba(255,255,255,0.85)" :
    tone === "dark" ? "rgb(129, 140, 248)" :
    "var(--chart-1)";
  return (
    <svg className="h-8 w-full opacity-90" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path d="M0,22 Q15,8 25,18 T50,12 T75,20 T100,6" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function HeroKpi({ label, value, color, index = 0, featured = false, onClick }: { label: string; value: unknown; color: string; index?: number; featured?: boolean; onClick?: () => void }) {
  // Rotate distinctive tile variants for an editorial bento feel.
  const variant = featured ? "featured" : ["soft", "dark", "accent", "soft"][index % 4];
  const clickProps = onClick
    ? { onClick, role: "button" as const, tabIndex: 0, onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } }
    : {};
  const clickable = onClick ? " cursor-pointer hover:ring-2 hover:ring-primary/40" : "";

  if (variant === "featured") {
    return (
      <Card {...clickProps} className={`group relative col-span-2 overflow-hidden rounded-3xl border-border/60 bg-card shadow-sm transition-all duration-500 hover:shadow-xl${clickable}`}>
        <div className="pointer-events-none absolute -right-12 -top-12 h-64 w-64 rounded-full bg-primary/10 blur-3xl transition-colors group-hover:bg-primary/20" />
        <CardContent className="relative flex h-full flex-col justify-between gap-6 p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">{label}</span>
              <div className="mt-2 text-4xl font-bold tracking-tight tabular-nums">{fmtNum(value)}</div>
            </div>
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-border bg-muted/40 text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
            </div>
          </div>
          <Sparkline />
        </CardContent>
      </Card>
    );
  }

  if (variant === "dark") {
    return (
      <Card {...clickProps} className={`group relative overflow-hidden rounded-3xl border-transparent bg-slate-900 text-slate-100 shadow-sm transition-transform duration-300 hover:-translate-y-0.5 dark:bg-slate-950${clickable}`}>
        <CardContent className="flex h-full flex-col justify-between gap-4 p-5">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 animate-pulse rounded-full" style={{ background: "rgb(129,140,248)" }} />
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{label}</span>
          </div>
          <div>
            <div className="text-3xl font-bold tabular-nums">{fmtNum(value)}</div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div className="h-full w-2/3 rounded-full" style={{ background: "rgb(129,140,248)" }} />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (variant === "accent") {
    return (
      <Card {...clickProps} className={`group relative overflow-hidden rounded-3xl border-transparent text-white shadow-lg transition-transform duration-300 hover:-translate-y-0.5${clickable}`} style={{ background: color }}>
        <CardContent className="flex h-full flex-col justify-between gap-4 p-5">
          <div className="flex items-start justify-between">
            <span className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-80">{label}</span>
            <div className="rounded-xl bg-white/20 p-1.5"><TrendingUp className="h-3.5 w-3.5" /></div>
          </div>
          <div className="text-4xl font-bold tracking-tight tabular-nums">{fmtNum(value)}</div>
        </CardContent>
      </Card>
    );
  }

  // soft
  return (
    <Card {...clickProps} className={`group relative overflow-hidden rounded-3xl border-border/70 bg-card shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-border hover:shadow-md${clickable}`}>
      <div className="absolute left-0 top-0 h-full w-1" style={{ background: color }} />
      <CardContent className="flex h-full flex-col justify-between gap-4 p-5">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{label}</span>
        <div className="flex items-end justify-between gap-3">
          <div className="text-3xl font-bold tracking-tight tabular-nums">{fmtNum(value)}</div>
          <div className="w-16"><Sparkline /></div>
        </div>
      </CardContent>
    </Card>
  );
}
function StackedBar({ data, onSelect }: { data: Record<string, number>; onSelect?: (key: string) => void }) {
  const entries = Object.entries(data).filter(([, v]) => Number(v) > 0);
  const total = entries.reduce((s, [, v]) => s + Number(v), 0) || 1;
  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {entries.map(([k, v], i) => (
          <div key={k} title={`${k}: ${v}`} onClick={onSelect ? () => onSelect(k) : undefined}
            style={{ width: `${(Number(v) / total) * 100}%`, background: STATUS_COLOR[k.toLowerCase()] || CHART_COLORS[i % CHART_COLORS.length], cursor: onSelect ? "pointer" : undefined }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map(([k, v], i) => (
          <button key={k} type="button" disabled={!onSelect} onClick={onSelect ? () => onSelect(k) : undefined}
            className={onSelect ? "transition-transform hover:-translate-y-0.5" : ""}>
            <Badge variant="outline" className="gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k.toLowerCase()] || CHART_COLORS[i % CHART_COLORS.length] }} />
              <span>{k}</span><span className="tabular-nums text-muted-foreground">{fmtNum(v)}</span>
            </Badge>
          </button>
        ))}
      </div>
    </div>
  );
}
function MiniBarChart({ data, color = "var(--chart-1)", onBarClick }: { data: { name: string; value: number }[]; color?: string; onBarClick?: (name: string, value: number) => void }) {
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? "end" : "middle"} height={data.length > 6 ? 50 : 30} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip cursor={{ fill: "hsl(var(--muted))" }} contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
          <Bar dataKey="value" radius={[6, 6, 0, 0]} onClick={onBarClick ? (d: any) => onBarClick(d?.name ?? d?.payload?.name, d?.value ?? d?.payload?.value) : undefined} style={onBarClick ? { cursor: "pointer" } : undefined}>
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

/* ========================== Drill-down ========================== */

type DrillPayload = {
  title: string;
  subtitle?: string;
  sheet?: Sheet;
  /** When omitted, all rows of `sheet` are shown. */
  predicate?: (row: Record<string, unknown>) => boolean;
  /** Human description of the filter (e.g. "status = Delayed"). */
  filterLabel?: string;
  /** Optional pre-supplied bullet reasons (skips/precedes AI). */
  reasons?: string[];
  /** Extra k/v context to display in the modal header. */
  extra?: Record<string, unknown>;
  /** Tone tag for the header badge. */
  kind?: "kpi" | "status" | "flag" | "chart" | "total";
};

type DrillCtxValue = { open: (p: DrillPayload) => void };
const DrillCtx = createContext<DrillCtxValue | null>(null);
function useDrill() { return useContext(DrillCtx); }

/** Infer a row predicate from a free-text label by matching distinct values of categorical columns. */
function inferPredicateFromLabel(sheet: Sheet | undefined, label: string): { predicate?: (r: Record<string, unknown>) => boolean; filterLabel?: string } {
  if (!sheet || !sheet.rows?.length) return {};
  const tokens = label.toLowerCase().replace(/[_\-]+/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return {};
  const cols = sheet.columns || [];
  // Prefer status-like columns first.
  const prioritized = [...cols].sort((a, b) => {
    const score = (n: string) => /status|state|stage|phase|severity|priority|criticality|category/i.test(n) ? -1 : 0;
    return score(a.name) - score(b.name);
  });
  for (const col of prioritized) {
    if (col.type === "number") continue;
    const distinct = new Set<string>();
    for (const r of sheet.rows) {
      const v = r[col.name];
      if (v == null || v === "") continue;
      distinct.add(String(v));
      if (distinct.size > 100) break;
    }
    for (const v of distinct) {
      const vl = v.toLowerCase();
      if (tokens.some(t => t.length > 2 && (vl === t || vl.includes(t) || t.includes(vl)))) {
        return {
          predicate: (r) => String(r[col.name] ?? "").toLowerCase() === vl,
          filterLabel: `${col.name} = ${v}`,
        };
      }
    }
  }
  return {};
}

function findColumnForValue(sheet: Sheet | undefined, value: string): string | undefined {
  if (!sheet?.rows?.length) return undefined;
  const vl = value.toLowerCase();
  const cols = sheet.columns || [];
  const prioritized = [...cols].sort((a, b) => {
    const score = (n: string) => /status|state|stage|phase|severity|priority/i.test(n) ? -1 : 0;
    return score(a.name) - score(b.name);
  });
  for (const col of prioritized) {
    if (col.type === "number") continue;
    for (const r of sheet.rows) {
      if (String(r[col.name] ?? "").toLowerCase() === vl) return col.name;
    }
  }
  return undefined;
}

function DrillDownDialog({ payload, onClose }: { payload: DrillPayload | null; onClose: () => void }) {
  const open = !!payload;
  const sheet = payload?.sheet;
  const allRows = sheet?.rows ?? [];
  const cols = sheet?.columns ?? [];

  const matched = useMemo(() => {
    if (!payload?.predicate) return allRows;
    return allRows.filter(payload.predicate);
  }, [payload, allRows]);

  // Build top-N breakdowns over categorical columns (excluding ones already in the title).
  const facets = useMemo(() => {
    if (!matched.length) return [] as { col: string; entries: [string, number][] }[];
    const candidates = cols
      .filter(c => c.type !== "number")
      .map(c => {
        const counts = new Map<string, number>();
        for (const r of matched) {
          const v = r[c.name];
          if (v == null || v === "") continue;
          const k = String(v);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        return { col: c.name, counts };
      })
      .filter(f => f.counts.size > 1 && f.counts.size <= 60)
      .sort((a, b) => b.counts.size - a.counts.size)
      .slice(0, 4)
      .map(f => ({
        col: f.col,
        entries: [...f.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) as [string, number][],
      }));
    return candidates;
  }, [matched, cols]);

  // AI reasons
  const [reasons, setReasons] = useState<string>("");
  const [reasonsLoading, setReasonsLoading] = useState(false);
  const [reasonsError, setReasonsError] = useState<string>("");

  useEffect(() => {
    if (!open) { setReasons(""); setReasonsError(""); return; }
    if (payload?.reasons?.length) { setReasons(payload.reasons.map(r => `- ${r}`).join("\n")); return; }
    if (!matched.length) { setReasons(""); return; }
    let cancelled = false;
    setReasonsLoading(true); setReasonsError("");
    const sample = matched.slice(0, 25);
    const facetSummary = facets.map(f => `${f.col}: ${f.entries.map(([k, v]) => `${k}=${v}`).join(", ")}`).join("\n");
    const ctx = [
      `Selected entity: ${payload?.title}`,
      payload?.subtitle ? `Subtitle: ${payload.subtitle}` : "",
      payload?.filterLabel ? `Filter: ${payload.filterLabel}` : "",
      `Sheet: ${sheet?.name || sheet?.label || "n/a"}`,
      `Matching row count: ${matched.length} of ${allRows.length}`,
      `Top breakdowns:\n${facetSummary || "n/a"}`,
      `Sample rows (JSON, ≤25):\n${JSON.stringify(sample).slice(0, 6000)}`,
    ].filter(Boolean).join("\n\n");
    generateGemini({
      system: GROUNDING_RULES + "\nYou are an analyst. Given the matching rows, explain WHY this metric/segment looks the way it does. Produce 4-6 short bullets. Reference exact column names and values from the data only. No speculation beyond the data.",
      prompt: ctx,
      temperature: 0.2,
    }).then(text => { if (!cancelled) setReasons(text || ""); })
      .catch(e => { if (!cancelled) setReasonsError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setReasonsLoading(false); });
    return () => { cancelled = true; };
  }, [open, payload, matched, facets, allRows.length, sheet]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            {payload?.kind && <Badge variant="outline" className="capitalize text-[10px]">{payload.kind}</Badge>}
            {sheet && <Badge variant="secondary" className="text-[10px]">{sheet.name || sheet.label}</Badge>}
            {payload?.filterLabel && <Badge variant="outline" className="text-[10px]">{payload.filterLabel}</Badge>}
          </div>
          <DialogTitle className="text-xl">{payload?.title}</DialogTitle>
          {payload?.subtitle && <p className="text-sm text-muted-foreground">{payload.subtitle}</p>}
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-5 pb-4">
            {/* Headline counts */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card className="rounded-2xl"><CardContent className="p-4">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Matching rows</div>
                <div className="mt-1 text-2xl font-bold tabular-nums">{fmtNum(matched.length)}</div>
              </CardContent></Card>
              <Card className="rounded-2xl"><CardContent className="p-4">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Share of sheet</div>
                <div className="mt-1 text-2xl font-bold tabular-nums">{allRows.length ? Math.round((matched.length / allRows.length) * 100) : 0}%</div>
              </CardContent></Card>
              {facets[0] && (
                <Card className="rounded-2xl"><CardContent className="p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Top {facets[0].col}</div>
                  <div className="mt-1 truncate text-sm font-semibold">{facets[0].entries[0]?.[0] ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{fmtNum(facets[0].entries[0]?.[1] ?? 0)} rows</div>
                </CardContent></Card>
              )}
              {payload?.extra && Object.entries(payload.extra).slice(0, 1).map(([k, v]) => (
                <Card key={k} className="rounded-2xl"><CardContent className="p-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.replace(/_/g, " ")}</div>
                  <div className="mt-1 truncate text-sm font-semibold">{fmtCell(v)}</div>
                </CardContent></Card>
              ))}
            </div>

            {/* AI reasons */}
            <Card className="rounded-2xl border-primary/30 bg-primary/5">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <CardTitle className="text-sm">Why this looks like it does</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="text-sm leading-relaxed">
                {reasonsLoading && <div className="text-muted-foreground">Analyzing matched rows…</div>}
                {reasonsError && <div className="text-destructive text-xs">{reasonsError}</div>}
                {!reasonsLoading && !reasonsError && reasons && (
                  <div className="whitespace-pre-wrap">{reasons}</div>
                )}
                {!reasonsLoading && !reasonsError && !reasons && (
                  <div className="text-muted-foreground">No matching rows to analyze.</div>
                )}
              </CardContent>
            </Card>

            {/* Facet breakdowns */}
            {facets.length > 0 && (
              <div className="grid gap-3 md:grid-cols-2">
                {facets.map(f => (
                  <Card key={f.col} className="rounded-2xl">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Top by {f.col}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1.5">
                      {f.entries.map(([k, v]) => {
                        const max = f.entries[0][1] || 1;
                        return (
                          <div key={k} className="flex items-center gap-2 text-xs">
                            <div className="w-32 truncate" title={k}>{k}</div>
                            <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                              <div className="h-full bg-primary/70" style={{ width: `${(v / max) * 100}%` }} />
                            </div>
                            <div className="w-12 text-right tabular-nums text-muted-foreground">{fmtNum(v)}</div>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {/* Matched rows */}
            {matched.length > 0 && cols.length > 0 && (
              <Card className="rounded-2xl">
                <CardHeader className="pb-2 flex flex-row items-center justify-between">
                  <CardTitle className="text-sm">Matching rows ({fmtNum(matched.length)})</CardTitle>
                  <Button variant="outline" size="sm" className="h-7 gap-1"
                    onClick={() => downloadCSV(`${sheet?.label || "drill"}.csv`, cols.map(c => c.name), matched)}>
                    <Download className="h-3 w-3" /> CSV
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  <ScrollArea className="max-h-[24rem]">
                    <Table>
                      <TableHeader className="sticky top-0 bg-card z-10">
                        <TableRow>
                          {cols.map(c => <TableHead key={c.name} className="whitespace-nowrap">{c.name}</TableHead>)}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {matched.slice(0, 500).map((r, i) => (
                          <TableRow key={i} className={i % 2 ? "bg-muted/30" : ""}>
                            {cols.map(c => {
                              const txt = fmtCell(r[c.name]);
                              const long = txt.length > 60;
                              return (
                                <TableCell key={c.name} className={`whitespace-nowrap ${c.type === "number" ? "tabular-nums text-right" : ""}`}>
                                  {long ? `${txt.slice(0, 60)}…` : txt}
                                </TableCell>
                              );
                            })}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                  {matched.length > 500 && (
                    <div className="border-t px-4 py-2 text-xs text-muted-foreground">
                      Showing first 500 of {fmtNum(matched.length)}. Export CSV for the full set.
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DrillProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<DrillPayload | null>(null);
  const open = useCallback((p: DrillPayload) => setPayload(p), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <DrillCtx.Provider value={value}>
      {children}
      <DrillDownDialog payload={payload} onClose={() => setPayload(null)} />
    </DrillCtx.Provider>
  );
}

/* ============================ Sections ============================ */


function isDelaySheet(sheet: Sheet, analysisIfBasis?: Analysis): boolean {
  const t = (sheet.type || "").toLowerCase();
  if (t.includes("progress") || t.includes("delay")) return true;
  if (analysisIfBasis) {
    const totals = analysisIfBasis.totals || {};
    if (["delayed", "blocked", "at_risk"].some(k => Number((totals as any)[k]) > 0)) return true;
    const sb = analysisIfBasis.status_breakdown || {};
    if (Object.keys(sb).some(k => k.toLowerCase() !== "unknown")) return true;
    const mode = (analysisIfBasis as any).mode;
    if (mode && mode !== "generic") return true;
  }
  return false;
}

function AIInsightsCard({ data, selected, isBasis }: { data: DashboardData; selected?: Sheet; isBasis?: boolean }) {
  const m = (data.modules || {}) as Record<string, any>;
  const basisContext = (() => {
    const digestFacts = (() => {
      const d = m.digest;
      if (d && typeof d === "object" && Array.isArray(d.facts)) return d.facts;
      return null;
    })();
    const recs = Array.isArray(m.recommendations) ? m.recommendations.slice(0, 3) : [];
    const dqScore = m.data_quality?.score;
    return {
      backend_summary: (typeof data.ai_summary === "string" ? data.ai_summary : "").trim(),
      digest_facts: digestFacts,
      top_recommendations: recs,
      data_quality_score: dqScore,
      totals: data.analysis?.totals,
      status_breakdown: data.analysis?.status_breakdown,
    };
  })();
  const sheetContext = selected && !isBasis ? {
    sheet_label: selected.label,
    sheet_type: selected.type,
    row_count: selected.row_count,
    kpis: selected.kpis,
    charts: (selected.charts || []).slice(0, 6).map(c => ({ title: c.title, data: (c.data || []).slice(0, 8) })),
    backend_summary: (typeof data.ai_summary === "string" ? data.ai_summary : "").trim(),
  } : null;

  const useSheet = !!sheetContext;
  const ctxJson = useMemo(
    () => JSON.stringify(useSheet ? sheetContext : basisContext, null, 2),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [useSheet, selected?.label, data]
  );
  const hasAnyContent = useSheet
    ? !!(sheetContext!.kpis?.length || sheetContext!.charts?.length || sheetContext!.backend_summary)
    : !!(basisContext.backend_summary || basisContext.digest_facts || (basisContext.top_recommendations?.length) || basisContext.totals);

  const [text, setText] = useState<string>(useSheet ? "" : basisContext.backend_summary);
  const [loading, setLoading] = useState(false);
  const [enhanced, setEnhanced] = useState(false);

  useEffect(() => {
    setEnhanced(false);
    setText(useSheet ? "" : basisContext.backend_summary);
    if (!hasGemini() || !hasAnyContent) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const out = await generateGemini({
          system: GROUNDING_RULES + "\nYou write concise executive insights for a data dashboard.",
          prompt: [
            "Write a 4-6 sentence narrative describing what the data shows and what to act on.",
            "Use ONLY the provided facts and numbers. Do not invent values. Mark advice as 'Suggestion:'.",
            useSheet ? `Focus strictly on the sheet "${selected!.label}".` : "",
            "Context (JSON):",
            ctxJson,
          ].filter(Boolean).join("\n\n"),
          temperature: 0.4,
        });
        if (!cancelled && out.trim()) { setText(out.trim()); setEnhanced(true); }
      } catch { /* keep fallback */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxJson, useSheet, hasAnyContent]);

  if (!hasAnyContent && !loading) return null;
  return (
    <Card className="rounded-2xl shadow-sm border-primary/30">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" /> AI Insights
          {useSheet && <Badge variant="outline" className="ml-1 px-1.5 py-0 text-[10px]">{selected!.label}</Badge>}
        </CardTitle>
        {enhanced && <Badge variant="outline" className="text-[10px]">Gemini</Badge>}
      </CardHeader>
      <CardContent className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
        {loading && !text ? "Generating insights…" : (text || "No narrative available for this sheet.")}
      </CardContent>
    </Card>
  );
}


function OverviewSection({ data, onSelectedChange, selectedLabel, onSelectedLabelChange }: { data: DashboardData; onSelectedChange?: (sheet: Sheet | undefined, isDelay: boolean) => void; selectedLabel?: string; onSelectedLabelChange?: (label: string) => void }) {
  const sheets = data.sheets || [];
  const [localLabel, setLocalLabel] = useState(sheets[0]?.label || "");
  const activeLabel = selectedLabel ?? localLabel;
  const setActiveLabel = (l: string) => { setLocalLabel(l); onSelectedLabelChange?.(l); };
  useEffect(() => {
    if (!sheets.find(s => s.label === activeLabel)) setActiveLabel(sheets[0]?.label || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets, activeLabel]);

  const selected = sheets.find(s => s.label === activeLabel) || sheets[0];
  const isBasis = !!selected && selected.label === sheets[0]?.label;
  const delay = !!selected && isBasis && isDelaySheet(selected, data.analysis);

  useEffect(() => {
    onSelectedChange?.(selected, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.label, delay]);

  const a = data.analysis || {};
  const m = data.modules || {};
  const totals = a.totals || {};
  const sb = a.status_breakdown || {};

  const flags = (a.flags || []).filter(Boolean);

  const extraAnalysis = Object.entries(a).filter(([k, v]) =>
    !["summary", "totals", "status_breakdown", "flags", "mode_badge"].includes(k) && !isEmpty(v));
  const extraModules = Object.entries(m).filter(([k, v]) =>
    !["data_quality", "digest", "recommendations", "risk_score"].includes(k) && !isEmpty(v));

  const genericModuleKeys = ["pivot", "anomalies", "forecast", "trends", "whatif"] as const;

  return (
    <div className="space-y-6">
      <AIInsightsCard data={data} selected={selected} isBasis={isBasis} />
      {/* Sheet selector */}
      {sheets.length > 0 && (
        <div className="sticky top-0 z-10 -mx-1 overflow-x-auto rounded-2xl bg-background/80 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2 text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Sheet</span>
            {sheets.map(s => (
              <button key={s.label} onClick={() => setActiveLabel(s.label)}
                className={`group flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all ${activeLabel === s.label ? "border-transparent bg-slate-900 text-slate-50 shadow-md shadow-slate-900/15 dark:bg-slate-100 dark:text-slate-900" : "border-border bg-card text-muted-foreground hover:-translate-y-0.5 hover:border-foreground/30 hover:text-foreground"}`}>
                <span>{s.label}</span>
                {s.type && <span className={`rounded-full px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider ${activeLabel === s.label ? "bg-white/15 text-slate-50 dark:bg-black/10 dark:text-slate-900" : "bg-muted text-muted-foreground"}`}>{s.type}</span>}
                {s.row_count != null && <span className="font-mono text-[10px] opacity-70">{fmtNum(s.row_count)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && !delay && (
        <>
          {/* Generic sheet: KPI hero tiles */}
          {!!selected.kpis?.length && (
            <div className="grid auto-rows-fr grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
              {selected.kpis.map((k, i) => (
                <HeroKpi key={i} label={k.label} value={k.value} color={CHART_COLORS[i % CHART_COLORS.length]} index={i} featured={i === 0} />
              ))}
            </div>
          )}

          {/* Generic sheet: charts (from API + auto-derived from rows for any column missed) */}
          {(() => {
            const apiCharts = selected.charts || [];
            const chartedCols = new Set<string>();
            apiCharts.forEach(c => {
              const m = /^(?:Count|Σ|Sum|Avg|Average)\s+(?:of\s+)?(.+?)(?:\s+by\s+(.+))?$/i.exec(c.title || "");
              if (m) { if (m[1]) chartedCols.add(m[1].trim()); if (m[2]) chartedCols.add(m[2].trim()); }
            });
            const cols = selected.columns || [];
            const rows = selected.rows || [];
            const numericCols = cols.filter(c => c.type === "number").map(c => c.name);
            const primaryNumeric = numericCols[0];
            const derived: ChartDef[] = [];
            cols.forEach(col => {
              if (chartedCols.has(col.name)) return;
              if (col.type === "number") return;
              if (!rows.length) return;
              const distinct = col.distinct ?? 0;
              if (distinct === 0 || distinct > 500) return;
              // Count aggregation
              const counts = new Map<string, number>();
              const sums = new Map<string, number>();
              rows.forEach(r => {
                const k = String(r[col.name] ?? "").trim();
                if (!k) return;
                counts.set(k, (counts.get(k) || 0) + 1);
                if (primaryNumeric) {
                  const n = Number(r[primaryNumeric]);
                  if (Number.isFinite(n)) sums.set(k, (sums.get(k) || 0) + n);
                }
              });
              const toTop = (m: Map<string, number>) => {
                const arr = [...m.entries()].sort((a, b) => b[1] - a[1]);
                const top = arr.slice(0, 8).map(([name, value]) => ({ name, value }));
                const rest = arr.slice(8).reduce((s, [, v]) => s + v, 0);
                if (rest > 0) top.push({ name: "Other", value: rest });
                return top;
              };
              derived.push({ type: "bar", title: `Count by ${col.name}`, x: "name", y: "value", data: toTop(counts) });
              if (primaryNumeric && sums.size) {
                derived.push({ type: "bar", title: `${primaryNumeric} by ${col.name}`, x: "name", y: "value", data: toTop(sums) });
              }
            });
            const all = [...apiCharts, ...derived];
            if (!all.length) return null;
            return (
              <div className="grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
                {all.map((c, i) => (
                  <Card key={i} className={`group overflow-hidden rounded-3xl border-border/60 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md ${i === 0 ? "md:col-span-2 xl:col-span-2 md:row-span-1" : ""}`}>
                    <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                      <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">{i === 0 ? "Primary trend" : "Breakdown"}</div>
                        <CardTitle className="mt-1 text-base font-semibold leading-tight truncate">{c.title}</CardTitle>
                      </div>
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-border/70 bg-muted/40 text-muted-foreground">
                        <Activity className="h-3.5 w-3.5" />
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0"><MiniBarChart data={c.data || []} color={CHART_COLORS[i % CHART_COLORS.length]} /></CardContent>
                  </Card>
                ))}
              </div>
            );
          })()}


          {/* Generic modules */}
          {(m.data_quality || m.digest || m.recommendations) && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {m.data_quality?.score != null && (
                <Card className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md"><CardContent className="p-5">
                  <Ring label="Data quality" value={Number(m.data_quality.score)} />
                  {!!m.data_quality.issues?.length && (
                    <div className="mt-3 text-xs text-muted-foreground">{m.data_quality.issues.length} issue(s)</div>
                  )}
                </CardContent></Card>
              )}
              {m.digest && (
                <Card className="rounded-3xl border-border/60 shadow-sm md:col-span-2 xl:col-span-3">
                  <CardHeader className="pb-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Editorial</div>
                    <CardTitle className="text-base font-semibold">Digest</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm leading-relaxed text-foreground/80">
                    {typeof m.digest === "string" ? m.digest : (m.digest as any).text}
                  </CardContent>
                </Card>
              )}
              {!!m.recommendations?.length && (
                <Card className="rounded-3xl border-border/60 bg-gradient-to-br from-card to-muted/30 shadow-sm md:col-span-2 xl:col-span-4">
                  <CardHeader className="pb-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600">Suggested</div>
                    <CardTitle className="text-base font-semibold">Recommendations</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="grid gap-2.5 text-sm md:grid-cols-2">
                      {m.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-2.5 rounded-2xl border border-border/50 bg-card/60 p-3">
                          <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </div>
                          <span>{typeof r === "string" ? r : (r.title ? <><strong>{r.title}</strong> — {r.detail}</> : r.detail)}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Extra generic modules: pivot/anomalies/forecast/trends/whatif */}
          {genericModuleKeys.some(k => !isEmpty((m as any)[k])) && (
            <div className="grid gap-4 md:grid-cols-2">
              {genericModuleKeys.map(k => {
                const v = (m as any)[k];
                if (isEmpty(v)) return null;
                return (
                  <Card key={k} className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md">
                    <CardHeader className="pb-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Module</div>
                      <CardTitle className="text-base font-semibold capitalize">{k}</CardTitle>
                    </CardHeader>
                    <CardContent><GenericValue value={v} /></CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {selected && delay && (
        <>
          {/* KPI tiles */}
          {!isEmpty(totals) && (
            <div className="grid auto-rows-fr grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
              {Object.entries(totals).map(([k, v], i) => (
                <HeroKpi key={k} label={k.replace(/_/g, " ")} value={v} color={CHART_COLORS[i % CHART_COLORS.length]} index={i} featured={i === 0} />
              ))}
            </div>
          )}

          {/* Summary callout */}
          {!isEmpty(a.summary) && (
            <Card className="overflow-hidden rounded-3xl border-border/60 bg-gradient-to-br from-primary/5 via-card to-card shadow-sm">
              <CardContent className="flex gap-4 p-5 text-sm leading-relaxed">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">Summary</div>
                  <p className="mt-1 text-foreground/90">{a.summary}</p>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 lg:grid-cols-5">
            {/* Status breakdown */}
            {!isEmpty(sb) && (
              <Card className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md lg:col-span-3">
                <CardHeader className="pb-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Composition</div>
                  <CardTitle className="text-base font-semibold">Status breakdown</CardTitle>
                </CardHeader>
                <CardContent><StackedBar data={sb as Record<string, number>} /></CardContent>
              </Card>
            )}
            {/* Flags */}
            {flags.length > 0 && (
              <Card className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md lg:col-span-2">
                <CardHeader className="pb-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-600">Attention</div>
                  <CardTitle className="text-base font-semibold">Flags</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 text-sm">
                    {flags.map((f, i) => (
                      <li key={i} className="flex items-start gap-2 rounded-xl border border-border/50 bg-card/60 p-2.5">
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
                <Card className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md"><CardContent className="p-5">
                  <Gauge label="Risk score" value={typeof a.risk_score === "number" ? a.risk_score : Number((a.risk_score as any)?.score) || 0} />
                </CardContent></Card>
              )}
              {m.data_quality?.score != null && (
                <Card className="rounded-3xl border-border/60 shadow-sm transition-all hover:shadow-md"><CardContent className="p-5">
                  <Ring label="Data quality" value={Number(m.data_quality.score)} />
                  {!!m.data_quality.issues?.length && (
                    <div className="mt-3 text-xs text-muted-foreground">{m.data_quality.issues.length} issue(s)</div>
                  )}
                </CardContent></Card>
              )}
              {m.digest && (
                <Card className="rounded-3xl border-border/60 shadow-sm md:col-span-2">
                  <CardHeader className="pb-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Editorial</div>
                    <CardTitle className="text-base font-semibold">Digest</CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm leading-relaxed text-foreground/80">
                    {typeof m.digest === "string" ? m.digest : (m.digest as any).text}
                  </CardContent>
                </Card>
              )}
              {!!m.recommendations?.length && (
                <Card className="rounded-3xl border-border/60 bg-gradient-to-br from-card to-muted/30 shadow-sm md:col-span-2 xl:col-span-4">
                  <CardHeader className="pb-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-600">Suggested</div>
                    <CardTitle className="text-base font-semibold">Recommendations</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="grid gap-2.5 text-sm md:grid-cols-2">
                      {m.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-2.5 rounded-2xl border border-border/50 bg-card/60 p-3">
                          <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          </div>
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
        </>
      )}

      {!selected && <SectionEmpty icon={LayoutDashboard} label="No sheets returned." />}
    </div>
  );
}


function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCSV(filename: string, columns: string[], rows: Record<string, unknown>[]) {
  const header = columns.map(csvEscape).join(",");
  const body = rows.map(r => columns.map(c => csvEscape(r[c])).join(",")).join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function SheetTable({ sheet }: { sheet: Sheet }) {
  const rows = sheet.rows || [];
  const columns = sheet.columns || [];
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [showFilters, setShowFilters] = useState(false);

  // Reset state when sheet changes
  useEffect(() => { setQ(""); setFilters({}); setPage(1); setSortCol(null); }, [sheet.label]);

  // Classify each non-numeric column as 'enum' (≤50 distinct → dropdown) or 'text' (high-cardinality → contains)
  const filterCols = useMemo(() => {
    const out: { name: string; kind: "enum" | "text"; values?: string[] }[] = [];
    for (const c of columns) {
      if (c.type === "number") continue;
      const set = new Set<string>();
      let total = 0;
      for (const r of rows) {
        const v = r[c.name];
        if (v == null || v === "") continue;
        total++;
        set.add(String(v));
      }
      if (total === 0 || set.size <= 1) continue;
      if (set.size <= 50) out.push({ name: c.name, kind: "enum", values: Array.from(set).sort() });
      else out.push({ name: c.name, kind: "text" });
    }
    return out;
  }, [rows, columns]);


  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let out = rows.filter(r => {
      for (const [col, val] of Object.entries(filters)) {
        if (!val) continue;
        const fc = filterCols.find(f => f.name === col);
        const cell = r[col];
        if (cell == null) return false;
        if (fc?.kind === "text") {
          if (!String(cell).toLowerCase().includes(val.toLowerCase())) return false;
        } else {
          if (String(cell) !== val) return false;
        }
      }

      if (!ql) return true;
      for (const c of columns) {
        const v = r[c.name];
        if (v != null && String(v).toLowerCase().includes(ql)) return true;
      }
      return false;
    });
    if (sortCol) {
      const dir = sortDir === "asc" ? 1 : -1;
      const col = columns.find(c => c.name === sortCol);
      const numeric = col?.type === "number";
      out = [...out].sort((a, b) => {
        const av = a[sortCol]; const bv = b[sortCol];
        if (av == null && bv == null) return 0;
        if (av == null) return 1; if (bv == null) return -1;
        if (numeric) return (Number(av) - Number(bv)) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    return out;
  }, [rows, columns, q, filters, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const toggleSort = (name: string) => {
    if (sortCol === name) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(name); setSortDir("asc"); }
  };

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="pb-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{sheet.name || sheet.label}</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {fmtNum(filtered.length)} of {fmtNum(rows.length)} rows
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={e => { setQ(e.target.value); setPage(1); }}
              placeholder="Search all columns…" className="pl-7 h-8 text-xs" />
          </div>
          <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => setShowFilters(s => !s)}>
            <FilterIcon className="h-3.5 w-3.5" />
            Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
          </Button>
          {activeFilterCount > 0 && (
            <Button variant="ghost" size="sm" className="h-8 gap-1" onClick={() => { setFilters({}); setPage(1); }}>
              <XIcon className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
          <Select value={String(pageSize)} onValueChange={v => { setPageSize(Number(v)); setPage(1); }}>
            <SelectTrigger className="h-8 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[50, 100, 250, 500, 1000].map(n => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1"
            onClick={() => downloadCSV(`${sheet.label}.csv`, columns.map(c => c.name), filtered)}>
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
        </div>
        {showFilters && filterCols.length > 0 && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 border-t pt-3">
            {filterCols.map(fc => (
              <div key={fc.name} className="space-y-1">
                <label className="text-[10px] uppercase tracking-wide text-muted-foreground">{fc.name}</label>
                {fc.kind === "enum" ? (
                  <Select value={filters[fc.name] || "__all__"} onValueChange={v => {
                    setFilters(f => ({ ...f, [fc.name]: v === "__all__" ? "" : v })); setPage(1);
                  }}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="All" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all__">All</SelectItem>
                      {fc.values!.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={filters[fc.name] || ""} placeholder="contains…" className="h-8 text-xs"
                    onChange={e => { setFilters(f => ({ ...f, [fc.name]: e.target.value })); setPage(1); }} />
                )}
              </div>
            ))}
          </div>
        )}

      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="max-h-[32rem] w-full">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10">
              <TableRow>
                {columns.map(c => (
                  <TableHead key={c.name}
                    onClick={() => toggleSort(c.name)}
                    className={`cursor-pointer select-none whitespace-nowrap ${c.type === "number" ? "text-right" : ""}`}>
                    {c.name}{sortCol === c.name ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((r, i) => (
                <TableRow key={(safePage - 1) * pageSize + i} className={i % 2 ? "bg-muted/30" : ""}>
                  {columns.map(c => {
                    const v = r[c.name];
                    const txt = fmtCell(v);
                    const long = txt.length > 60;
                    return (
                      <TableCell key={c.name} className={`whitespace-nowrap ${c.type === "number" ? "tabular-nums text-right" : ""}`}>
                        {long ? (
                          <TooltipProvider><UITooltip><TooltipTrigger asChild><span className="cursor-default">{txt.slice(0, 60)}…</span></TooltipTrigger><TooltipContent className="max-w-md break-words">{txt}</TooltipContent></UITooltip></TooltipProvider>
                        ) : txt}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {paged.length === 0 && (
                <TableRow><TableCell colSpan={columns.length} className="text-center text-xs text-muted-foreground py-6">No rows match.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>Page {safePage} of {totalPages}</span>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" className="h-7" disabled={safePage <= 1} onClick={() => setPage(1)}>First</Button>
            <Button variant="outline" size="sm" className="h-7" disabled={safePage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Prev</Button>
            <Button variant="outline" size="sm" className="h-7" disabled={safePage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
            <Button variant="outline" size="sm" className="h-7" disabled={safePage >= totalPages} onClick={() => setPage(totalPages)}>Last</Button>
          </div>
        </div>
      </CardContent>
    </Card>
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

      {!!sheet.rows?.length && !!sheet.columns?.length && <SheetTable sheet={sheet} />}
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

function CopilotSection({ base, sheets, data, selectedLabel, onSelectedLabelChange }: { base: string; sheets: Sheet[]; data: DashboardData; selectedLabel?: string; onSelectedLabelChange?: (label: string) => void }) {
  const [localSelected, setLocalSelected] = useState(sheets[0]?.label || "");
  const selected = selectedLabel ?? localSelected;
  const setSelected = (l: string) => { setLocalSelected(l); onSelectedLabelChange?.(l); };
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; text: string; meta?: string; cites?: string[] }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<Map<string, { text: string; meta?: string; cites?: string[] }>>(new Map());

  useEffect(() => { setMessages([]); cacheRef.current.clear(); }, [base, selected]);
  useEffect(() => { scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" }); }, [messages]);

  // Build runtime catalog from currently loaded data (no hardcoded names).
  const catalog = useMemo(() => {
    const pivotMod = (data?.modules as Record<string, unknown> | undefined)?.pivot as
      | { available_dimensions?: string[]; available_measures?: string[]; per_sheet?: Record<string, { available_dimensions?: string[]; available_measures?: string[] }> }
      | undefined;
    return sheets.map(s => {
      const perSheet = pivotMod?.per_sheet?.[s.label];
      return {
        label: s.label,
        type: s.type,
        row_count: s.row_count,
        columns: (s.columns || []).map(c => ({ name: c.name, type: c.type })),
        available_dimensions: perSheet?.available_dimensions || pivotMod?.available_dimensions || [],
        available_measures: perSheet?.available_measures || pivotMod?.available_measures || [],
      };
    });
  }, [sheets, data]);

  const activeSheet = useMemo(() => sheets.find(s => s.label === selected) || sheets[0], [sheets, selected]);
  const colNames = useMemo(
    () => new Set((activeSheet?.columns || []).map(c => c.name)),
    [activeSheet]
  );

  // Generic chips derived from catalog — no domain assumptions.
  const chips = useMemo(() => {
    const cat = catalog.find(c => c.label === activeSheet?.label) || catalog[0];
    const dim = cat?.available_dimensions?.[0] || cat?.columns?.find(c => (c.type || "").match(/string|text|cat/i))?.name;
    const meas = cat?.available_measures?.[0] || cat?.columns?.find(c => (c.type || "").match(/num|int|float|decimal/i))?.name;
    const out: string[] = ["Summarize this sheet"];
    if (dim && meas) out.push(`Top ${dim} by ${meas}`);
    if (dim) out.push(`Count by ${dim}`);
    out.push("Any anomalies?");
    out.push("Data quality issues");
    return out;
  }, [catalog, activeSheet]);

  async function callEndpoint(endpoint: string, params: Record<string, string> | undefined, sheet?: string) {
    const qp = new URLSearchParams();
    if (sheet) qp.set("sheet", sheet);
    if (params) for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qp.set(k, String(v));
    const qs = qp.toString();
    const url = `${base}/${endpoint}${qs ? `?${qs}` : ""}`;
    return apiGet<unknown>(url);
  }

  // Collect referenced field names from route params + payload, intersected with this sheet's columns.
  function deriveCitations(params: Record<string, unknown> | undefined, payload: unknown, allowed: Set<string>): string[] {
    const found = new Set<string>();
    const visit = (v: unknown, depth = 0) => {
      if (depth > 4 || v == null) return;
      if (typeof v === "string") { if (allowed.has(v)) found.add(v); return; }
      if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
      if (typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (allowed.has(k)) found.add(k);
          visit(val, depth + 1);
        }
      }
    };
    visit(params);
    visit(payload);
    return [...found].slice(0, 8);
  }

  async function answer(question: string) {
    const sheetLabel = activeSheet?.label || "";
    if (!sheetLabel) {
      setMessages(m => [...m, { role: "assistant", text: "Select a sheet to ask questions about." }]);
      return;
    }
    const cacheKey = `${base}|${sheetLabel}|${question.toLowerCase().trim()}`;
    const hit = cacheRef.current.get(cacheKey);
    if (hit) {
      setMessages(m => [...m, { role: "assistant", text: hit.text, meta: hit.meta, cites: hit.cites }]);
      return;
    }
    setBusy(true);
    try {
      const { routeInsightQuestion, phraseInsightAnswer } = await import("@/lib/insights-copilot.functions");
      // Only expose the currently selected sheet to the router so it can't pivot elsewhere.
      const lockedCatalog = catalog.filter(c => c.label === sheetLabel);
      const route = await routeInsightQuestion({ data: { question, sheets: lockedCatalog } });

      if (!route || route.endpoint === "none") {
        const text = `I can only answer from "${sheetLabel}". ${route?.reason || "That question isn't covered by its columns."}`.trim();
        setMessages(m => [...m, { role: "assistant", text }]);
        return;
      }

      // Hard-lock the sheet regardless of what the router returned.
      const chosenSheet = sheetLabel;
      const sheetMeta = catalog.find(c => c.label === chosenSheet);
      const sheetCols = new Set((sheetMeta?.columns || []).map(c => c.name));

      // Validate column refs against runtime list (Gemini may hallucinate).
      if (route.endpoint === "pivot") {
        const p = route.params || {};
        const dim = String(p.dimension || "");
        const meas = String(p.measure || "");
        if (!sheetCols.has(dim) || !sheetCols.has(meas)) {
          setMessages(m => [...m, {
            role: "assistant",
            text: `No matching column on "${chosenSheet}". Available: ${[...sheetCols].slice(0, 12).join(", ")}${sheetCols.size > 12 ? "…" : ""}`,
          }]);
          return;
        }
      }

      let payload: unknown;
      try {
        payload = await callEndpoint(route.endpoint, route.params, chosenSheet);
      } catch (e) {
        // Fallback: try the link's own /copilot endpoint if available, still pinned to this sheet.
        if (route.endpoint !== "copilot") {
          try {
            const fb = await apiSend<{ answer?: string; generated_by?: string; fields_used?: string[] }>(`${base}/copilot?sheet=${encodeURIComponent(chosenSheet)}`, "POST", { message: question, sheet: chosenSheet });
            let text = fb?.answer || `No data available (${(e as Error).message}).`;
            let meta = `via /copilot · ${chosenSheet}`;
            if (fb?.generated_by === "computed" && hasGemini() && fb?.answer) {
              try {
                const ctx = JSON.stringify({ sheet: chosenSheet, modules: data.modules || {}, backend_answer: fb.answer }, null, 2);
                const out = await generateGemini({
                  system: GROUNDING_RULES + `\nYou are a data copilot restricted to the sheet "${chosenSheet}". Use only provided numbers. If the answer requires data from another sheet, say so.`,
                  prompt: `User question: ${question}\n\nContext (JSON):\n${ctx}`,
                  temperature: 0.3,
                });
                if (out.trim()) { text = out.trim(); meta = `via /copilot · ${chosenSheet} · Gemini`; }
              } catch { /* keep raw */ }
            }
            const cites = deriveCitations(undefined, fb, sheetCols).concat(fb?.fields_used?.filter(f => sheetCols.has(f)) || []);
            const uniqueCites = [...new Set(cites)];
            cacheRef.current.set(cacheKey, { text, meta, cites: uniqueCites });
            setMessages(m => [...m, { role: "assistant", text, meta, cites: uniqueCites }]);
            return;
          } catch { /* fallthrough */ }
        }
        setMessages(m => [...m, { role: "assistant", text: `Backend error: ${(e as Error).message}` }]);
        return;
      }

      // Honest relay of "not ready" messages.
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const obj = payload as Record<string, unknown>;
        if (obj.enabled === false && typeof obj.message === "string") {
          setMessages(m => [...m, { role: "assistant", text: String(obj.message), meta: `via /${route.endpoint}` }]);
          return;
        }
      }

      const payloadObj = (payload && typeof payload === "object" && !Array.isArray(payload))
        ? (payload as Record<string, unknown>) : null;
      const isComputed = payloadObj?.generated_by === "computed";

      const baseCites = deriveCitations(route.params as Record<string, unknown> | undefined, payload, sheetCols);

      if (isComputed && hasGemini()) {
        try {
          const ctx = JSON.stringify({
            sheet: chosenSheet,
            modules: data.modules || {},
            backend_answer: payloadObj?.answer ?? payloadObj,
          }, null, 2);
          const out = await generateGemini({
            system: GROUNDING_RULES + `\nYou are a data copilot restricted to the sheet "${chosenSheet}". Use only the provided numbers and facts. If the question needs data outside this sheet, say so.`,
            prompt: `User question: ${question}\n\nContext (JSON):\n${ctx}`,
            temperature: 0.3,
          });
          const text = out.trim() || String(payloadObj?.answer ?? "");
          const meta = `via /${route.endpoint} · ${chosenSheet} · Gemini`;
          cacheRef.current.set(cacheKey, { text, meta, cites: baseCites });
          setMessages(m => [...m, { role: "assistant", text, meta, cites: baseCites }]);
          return;
        } catch {
          // fall through to server phrasing
        }
      }

      const phr = await phraseInsightAnswer({
        data: { question, endpoint: route.endpoint, params: route.params, sheet: chosenSheet, payload },
      });
      const meta = `via /${route.endpoint} · ${chosenSheet}`;
      cacheRef.current.set(cacheKey, { text: phr.text, meta, cites: baseCites });
      setMessages(m => [...m, { role: "assistant", text: phr.text, meta, cites: baseCites }]);
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `Error: ${(e as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  const send = (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setMessages(m => [...m, { role: "user", text }]);
    setInput("");
    void answer(text);
  };

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Sparkles className="h-4 w-4 text-primary" /> Copilot</CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">Lovable + Gemini</Badge>
          {sheets.length > 1 && (
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger className="h-8 w-48"><SelectValue placeholder="Select sheet" /></SelectTrigger>
              <SelectContent>{sheets.map(s => <SelectItem key={s.label} value={s.label}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div ref={scrollerRef} className="mb-3 max-h-[28rem] min-h-[14rem] space-y-3 overflow-y-auto rounded-xl bg-muted/30 p-3">
          {messages.length === 0 && (
            <div className="text-center text-xs text-muted-foreground">
              Scoped to <span className="font-medium text-foreground">{activeSheet?.label || "—"}</span>. I'll only answer from this sheet's data and cite the exact fields I used.
              {colNames.size > 0 && (
                <div className="mt-1 opacity-70">Columns: {[...colNames].slice(0, 8).join(", ")}{colNames.size > 8 ? "…" : ""}</div>
              )}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-card"}`}>
                <div className="whitespace-pre-wrap">{m.text}</div>
                {(m.meta || (m.cites && m.cites.length > 0)) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {m.meta && <Badge variant="secondary" className="text-[10px] font-normal">{m.meta}</Badge>}
                    {m.cites?.map(f => (
                      <Badge key={f} variant="outline" className="text-[10px] font-normal" title={`Field from "${activeSheet?.label}"`}>
                        <span className="opacity-60 mr-0.5">field:</span>{f}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start"><div className="rounded-2xl bg-card px-3 py-2 text-sm shadow-sm text-muted-foreground">Thinking<span className="inline-block w-6 animate-pulse">…</span></div></div>
          )}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map(c => (
            <button key={c} onClick={() => send(c)} className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground" disabled={busy}>{c}</button>
          ))}
        </div>
        <form onSubmit={e => { e.preventDefault(); send(input); }} className="flex gap-2">
          <Input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask the copilot…" disabled={busy} />
          <Button type="submit" disabled={busy || !input.trim()}><Send className="h-4 w-4" /></Button>
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
  const { raw, setRaw, active, error, apply, clear } = useLinkInput();
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

  const [overviewSelected, setOverviewSelected] = useState<{ sheet?: Sheet; isDelay: boolean }>({ isDelay: false });
  const [sharedSheetLabel, setSharedSheetLabel] = useState<string>("");
  useEffect(() => {
    if (!sharedSheetLabel && sheets[0]?.label) setSharedSheetLabel(sheets[0].label);
    if (sharedSheetLabel && !sheets.find(s => s.label === sharedSheetLabel)) setSharedSheetLabel(sheets[0]?.label || "");
  }, [sheets, sharedSheetLabel]);

  const hasAnyDelaySheet = useMemo(
    () => sheets.some((s, i) => isDelaySheet(s, i === 0 ? data.analysis : undefined)),
    [sheets, data.analysis]
  );
  const visibleTabs = useMemo(
    () => TABS.filter(t => (t.id === "concerns" || t.id === "reminders") ? hasAnyDelaySheet : true),
    [hasAnyDelaySheet]
  );
  useEffect(() => {
    if (!visibleTabs.find(t => t.id === tab)) setTab("overview");
  }, [visibleTabs, tab]);


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
    <DrillProvider>
    <div className="space-y-4">
      {/* Sticky header */}
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary"><Activity className="h-4 w-4" /></div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{project}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {overviewSelected.isDelay && modeBadge
                  ? <Badge variant="outline" className="px-1.5 py-0 text-[10px] capitalize">{modeBadge}</Badge>
                  : overviewSelected.sheet
                    ? <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{overviewSelected.sheet.type || overviewSelected.sheet.label}</Badge>
                    : null}

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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clear}
              disabled={!raw && !active}
              title="Clear link"
            >
              Clear
            </Button>

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
                {visibleTabs.map(t => <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
            {/* Tab rail */}
            <aside className="hidden md:block">
              <nav className="space-y-1 rounded-2xl border border-border bg-card p-2">
                {visibleTabs.map(t => {
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

              {!dq.isPending && tab === "overview" && <OverviewSection data={data} selectedLabel={sharedSheetLabel} onSelectedLabelChange={setSharedSheetLabel} onSelectedChange={(sheet, isDelay) => setOverviewSelected({ sheet, isDelay })} />}
              {!dq.isPending && tab === "sheets" && <SheetsSection sheets={sheets} />}
              {!dq.isPending && tab === "concerns" && active && hasAnyDelaySheet && <ConcernsSection base={active} sheets={sheets} onRemind={openRemind} />}
              {!dq.isPending && tab === "reminders" && active && hasAnyDelaySheet && <RemindersSection base={active} onNew={() => { setReminderPrefill(undefined); setReminderOpen(true); }} />}
              {!dq.isPending && tab === "copilot" && active && <CopilotSection base={active} sheets={sheets} data={data} selectedLabel={sharedSheetLabel} onSelectedLabelChange={setSharedSheetLabel} />}
              {!dq.isPending && tab === "hygiene" && active && <HygieneSection base={active} />}
            </div>
          </div>

          <ReminderDialog open={reminderOpen} onOpenChange={setReminderOpen} base={active} prefill={reminderPrefill} />
        </>
      )}
    </div>
  );
}
