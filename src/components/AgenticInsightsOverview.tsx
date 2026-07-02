import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import {
  AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2,
  ChevronDown, Copy, RefreshCcw, Sparkles, TrendingUp,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { fetchInsightUrl } from "@/lib/insights-proxy.functions";
import { generateGemini } from "@/lib/gemini-client";

/* ================================================================== *
 * Types (kept loose — payload is user-controlled)
 * ================================================================== */

type Totals = { label: string; value: number | string }[];
type Flag = { message?: string; title?: string; severity?: string };
type SheetAnalysis = {
  sheet?: string; sheet_type?: string; mode_label?: string;
  summary?: string; totals?: Totals;
};
type Analysis = {
  mode?: string; mode_badge?: string; flags?: Flag[];
  sheet_analyses?: SheetAnalysis[];
};

type PivotRow = { key: string; value: number; rows?: number };
type Pivot = {
  enabled?: boolean; dimension?: string; measure?: string;
  agg?: string; total?: number; data?: PivotRow[];
  available_dimensions?: string[]; available_measures?: string[];
  available_sheets?: string[]; sheet?: string;
};
type Anomaly = { label?: string; column?: string; value?: number; score?: number; direction?: string };
type Anomalies = { enabled?: boolean; count?: number; anomalies?: Anomaly[]; sheet?: string };
type StockData = { key: string; value: number };
type StockViews = {
  enabled?: boolean; item_dimension?: string; sheet?: string;
  top_consumers?: { measure?: string; data?: StockData[] };
  low_balance?: { measure?: string; data?: StockData[] };
};
type Quality = { sheets?: { sheet?: string; score?: number; issues?: string[] }[] };
type Recommendation = { severity?: string; title?: string; detail?: string };
type Recommendations = { recommendations?: Recommendation[] };
type Forecast = { enabled?: boolean; ready?: boolean; message?: string };
type Trends = { ready?: boolean; series?: Record<string, unknown>[]; snapshot_count?: number };
type Digest = { facts?: string[]; sheets?: { highlights?: string[] }[] };

type Modules = {
  pivot?: Pivot; anomalies?: Anomalies; stock_views?: StockViews;
  data_quality?: Quality; recommendations?: Recommendations;
  forecast?: Forecast; trends?: Trends; digest?: Digest;
  whatif?: Record<string, unknown>;
};

type SheetLite = {
  label?: string; name?: string; row_count?: number;
  columns?: { name: string; type?: string }[];
  rows?: Record<string, unknown>[];
  item_dim?: string; measure?: string;
  column_roles?: {
    key?: string; balance?: string[]; consumption?: string;
    balance_columns?: string[]; consumption_column?: string;
  };
};

export type AgenticDashboardData = {
  project?: string;
  ai_summary?: string;
  analysis?: Analysis;
  modules?: Modules;
  sheets?: SheetLite[];
};

/* ================================================================== *
 * Formatting
 * ================================================================== */

const nf = new Intl.NumberFormat("en-IN");
const CURRENCY_RE = /value|amount|cost|price|revenue|₹|inr|budget/i;

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const clean = v.replace(/[₹$€£,\s]/g, "").replace(/%$/, "");
    if (clean.trim() === "") return null;
    const n = Number(clean);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function fmt(v: unknown, label = ""): string {
  const n = toNum(v);
  if (n == null) return v == null || v === "" ? "—" : String(v);
  const isCurrency = CURRENCY_RE.test(label);
  const abs = Math.abs(n);
  const nice = abs >= 100000
    ? nf.format(Math.round(n))
    : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return isCurrency ? `₹${nice}` : nice;
}
function pct(v: number): string {
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
}

/* ================================================================== *
 * Severity model — high | medium | low | ok
 * ================================================================== */

type Severity = "high" | "medium" | "low" | "ok";

const SEV_TEXT: Record<Severity, string> = {
  high: "text-destructive",
  medium: "text-warning",
  low: "text-muted-foreground",
  ok: "text-success",
};
const SEV_BG: Record<Severity, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-warning/15 text-warning",
  low: "bg-muted text-muted-foreground",
  ok: "bg-success/10 text-success",
};
const SEV_BORDER: Record<Severity, string> = {
  high: "border-l-destructive",
  medium: "border-l-warning",
  low: "border-l-muted-foreground/40",
  ok: "border-l-success",
};
const SEV_DOT: Record<Severity, string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-muted-foreground/60",
  ok: "bg-success",
};
const SEV_PILL_LABEL: Record<Severity, string> = {
  high: "Short",
  medium: "Low",
  low: "Watch",
  ok: "OK",
};
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, ok: 3 };

function normSeverity(raw?: string): Severity {
  const s = (raw || "").toLowerCase();
  if (s === "high" || s === "critical" || s === "urgent") return "high";
  if (s === "medium" || s === "warn" || s === "warning" || s === "mid") return "medium";
  if (s === "ok" || s === "healthy" || s === "good") return "ok";
  return "low";
}

/* ================================================================== *
 * Recommendation engine — rule-based, no LLM in the hot path
 * ================================================================== */

type RuleResult = { text: string; severity: Severity };

function findColumn(sheet: SheetLite | undefined, patterns: RegExp[]): string | undefined {
  if (!sheet) return undefined;
  const cols = sheet.columns?.map((c) => c.name) || Object.keys(sheet.rows?.[0] || {});
  for (const p of patterns) {
    const hit = cols.find((c) => p.test(c));
    if (hit) return hit;
  }
  return undefined;
}
function inventoryColumns(sheet: SheetLite | undefined) {
  const roles = sheet?.column_roles || {};
  const balanceCol =
    (Array.isArray(roles.balance) && roles.balance[0]) ||
    (Array.isArray(roles.balance_columns) && roles.balance_columns[0]) ||
    findColumn(sheet, [/balance/i, /closing[_ ]?stock/i, /on[_ ]?hand/i, /stock\b/i]);
  const consumptionCol =
    roles.consumption ||
    roles.consumption_column ||
    findColumn(sheet, [/consumption/i, /issued/i, /used/i, /consumed/i]);
  const keyCol = roles.key || sheet?.item_dim || findColumn(sheet, [/item/i, /material/i, /product/i, /name/i]);
  return { balanceCol, consumptionCol, keyCol };
}

export function recommendationForInventoryRow(
  row: Record<string, unknown>,
  sheet: SheetLite | undefined,
): RuleResult {
  const { balanceCol, consumptionCol } = inventoryColumns(sheet);
  const bal = balanceCol ? toNum(row[balanceCol]) : null;
  const cons = consumptionCol ? toNum(row[consumptionCol]) : null;
  if (bal != null && bal <= 0) return { text: "Out of stock — reorder now", severity: "high" };
  if (bal != null && cons != null && cons > 0 && bal < cons) {
    return { text: "Low stock — reorder soon", severity: "medium" };
  }
  if (cons != null && cons === 0 && bal != null && bal > 0) {
    return { text: "No movement — review", severity: "low" };
  }
  if (bal != null && cons != null && cons > 0 && bal > 4 * cons) {
    return { text: "Overstocked — hold ordering", severity: "low" };
  }
  return { text: "Levels healthy", severity: "ok" };
}

export function recommendationForGenericRow(
  row: Record<string, unknown>,
  sheet: SheetLite | undefined,
  anomalyLabels: Set<string>,
): RuleResult {
  const { keyCol } = inventoryColumns(sheet);
  const keyVal = keyCol ? String(row[keyCol] ?? "").trim() : "";
  if (keyVal && anomalyLabels.has(keyVal.toLowerCase())) {
    return { text: "Outlier — investigate", severity: "high" };
  }
  if (keyCol && !keyVal) return { text: "Missing key — complete", severity: "medium" };
  return { text: "Nominal", severity: "ok" };
}

/* ================================================================== *
 * Extract next-best-actions from the whole payload
 * ================================================================== */

type Action = {
  id: string;
  source: "Recommendation" | "Flag" | "Anomaly" | "Shortage" | "Quality";
  severity: Severity;
  title: string;
  detail?: string;
};

function buildActions(data: AgenticDashboardData): Action[] {
  const out: Action[] = [];
  const seen = new Set<string>();
  const push = (a: Action) => {
    const key = `${a.source}:${a.title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(a);
  };

  const recs = data.modules?.recommendations?.recommendations || [];
  recs.forEach((r, i) => {
    const title = r.title || r.detail || "Recommendation";
    push({
      id: `rec-${i}`,
      source: "Recommendation",
      severity: normSeverity(r.severity),
      title,
      detail: r.title ? r.detail : undefined,
    });
  });

  const flags = data.analysis?.flags || [];
  flags.forEach((f, i) => {
    const sev = normSeverity(f.severity);
    if (sev === "ok") return;
    push({
      id: `flag-${i}`,
      source: "Flag",
      severity: sev,
      title: f.title || f.message || "Flag raised",
      detail: f.title && f.message ? f.message : undefined,
    });
  });

  const anomalies = data.modules?.anomalies?.anomalies || [];
  anomalies.slice(0, 8).forEach((a, i) => {
    const label = a.label || "row";
    const score = a.score != null ? `${Number(a.score).toFixed(1)}×` : "outlier";
    const val = a.value != null ? fmt(a.value) : "";
    const col = a.column ? ` (${a.column})` : "";
    push({
      id: `anom-${i}`,
      source: "Anomaly",
      severity: "high",
      title: `Investigate ${label}${col}`,
      detail: `${a.column || "value"} is ${val}, ${score} expected`,
    });
  });

  const lows = data.modules?.stock_views?.low_balance?.data || [];
  lows.forEach((s, i) => {
    if (s.value > 0) return;
    push({
      id: `short-${i}`,
      source: "Shortage",
      severity: "high",
      title: `Reorder ${s.key} — short by ${fmt(Math.abs(s.value))}`,
    });
  });

  const qIssues = data.modules?.data_quality?.sheets?.[0]?.issues || [];
  qIssues.slice(0, 6).forEach((iss, i) =>
    push({ id: `q-${i}`, source: "Quality", severity: "medium", title: `Fix data quality: ${iss}` }),
  );

  out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  return out;
}

/* ================================================================== *
 * Small primitives
 * ================================================================== */

function SparkleIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return <Sparkles className={className} aria-hidden="true" />;
}
function AiTag({ children = "AI generated" }: { children?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
      <SparkleIcon className="h-3 w-3" />
      {children}
    </span>
  );
}
function AiLine({ children, severity = "low" }: { children: React.ReactNode; severity?: Severity }) {
  return (
    <div className="mt-2 flex items-start gap-1.5 text-xs">
      <SparkleIcon className={`mt-0.5 h-3 w-3 shrink-0 ${SEV_TEXT[severity]}`} />
      <span className="text-muted-foreground">
        <span className="sr-only">AI suggestion: </span>
        {children}
      </span>
    </div>
  );
}
function SectionTitle({
  eyebrow, title, caption, right,
}: { eyebrow: string; title: string; caption?: string; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {eyebrow}
        </div>
        <h2 className="mt-0.5 truncate text-lg font-semibold tracking-tight">{title}</h2>
        {caption && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <SparkleIcon className="h-3 w-3 text-primary" /> {caption}
          </div>
        )}
      </div>
      {right}
    </div>
  );
}

/* ================================================================== *
 * Grounded Gemini — single batched call for the whole page
 * ================================================================== */

type GeminiOut = { brief?: string; bullets?: string[]; items?: Record<string, { text?: string }> };

function buildFacts(data: AgenticDashboardData, actions: Action[]) {
  return {
    project: data.project,
    mode_badge: data.analysis?.mode_badge,
    headline_totals: data.analysis?.sheet_analyses?.[0]?.totals?.slice(0, 6),
    top_actions: actions.slice(0, 10).map((a) => ({
      id: a.id, severity: a.severity, source: a.source, title: a.title, detail: a.detail,
    })),
    top_anomalies: (data.modules?.anomalies?.anomalies || []).slice(0, 5),
    quality: data.modules?.data_quality?.sheets?.[0],
    digest: data.modules?.digest?.sheets?.[0]?.highlights?.slice(0, 6),
  };
}
function parseJsonLoose(s: string): unknown {
  try { return JSON.parse(s); } catch { /* fallthrough */ }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* ignore */ } }
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { /* ignore */ }
  }
  return null;
}
function useGroundedGemini(facts: unknown, hasContent: boolean) {
  return useQuery({
    queryKey: ["agentic-gemini", JSON.stringify(facts).slice(0, 400), JSON.stringify(facts).length],
    enabled: hasContent,
    staleTime: 5 * 60_000,
    retry: 0,
    queryFn: async (): Promise<GeminiOut> => {
      const system = [
        "You rewrite dashboard commentary from a compact FACTS JSON.",
        "Rules:",
        "- Use only the numbers and labels present in FACTS. Never invent, compute, sum, or estimate.",
        "- Keep the given severity for each item; do not change it.",
        "- Return STRICT JSON only: { brief: string, bullets: string[], items: { [id]: { text: string } } }.",
        "- brief: 3–5 short sentences of executive commentary in plain English.",
        "- bullets: 2–4 short bullet strings drawn from digest/highlights facts.",
        "- items: for each top_actions[i].id, one crisp sentence (<= 18 words) rephrasing the action.",
        "- No markdown fences. JSON only.",
      ].join("\n");
      const prompt = `FACTS:\n${JSON.stringify(facts)}`;
      const res = await generateGemini({ system, prompt, temperature: 0.2 });
      const parsed = parseJsonLoose(res) as GeminiOut | null;
      return parsed || {};
    },
  });
}

/* ================================================================== *
 * KPI cards (Hero)
 * ================================================================== */

const KPI_PRIORITY = /(grn|issued|consumption|balance|total|net|value|amount|revenue|cost)/i;

function pickHeroTotals(totals: Totals | undefined, trendsReady: boolean, trendDelta: number | null): {
  label: string; value: number | string; hint?: string; delta?: number; severity: Severity;
}[] {
  if (!totals?.length) return [];
  const sorted = [...totals].sort((a, b) => {
    const ap = KPI_PRIORITY.test(a.label) ? 0 : 1;
    const bp = KPI_PRIORITY.test(b.label) ? 0 : 1;
    return ap - bp;
  });
  const kept = sorted.slice(0, 4);
  const total = totals.find((t) => /total/i.test(t.label))?.value;
  const totalNum = toNum(total);
  return kept.map((k, i) => {
    const v = toNum(k.value);
    let hint: string | undefined;
    if (v != null && totalNum && totalNum !== v && /balance|net|issued|consumption/i.test(k.label)) {
      const share = (v / totalNum) * 100;
      if (Number.isFinite(share) && share > 0 && share < 100) hint = `${pct(share)} of total`;
    }
    return {
      label: k.label,
      value: k.value,
      hint,
      delta: i === 0 && trendsReady && trendDelta != null ? trendDelta : undefined,
      severity: "ok" as Severity,
    };
  });
}
function computeTrendDelta(trends?: Trends): number | null {
  const s = trends?.series || [];
  if (!trends?.ready || s.length < 2) return null;
  const numericKey = Object.keys(s[s.length - 1]).find((k) => k !== "date" && toNum(s[s.length - 1][k]) != null);
  if (!numericKey) return null;
  const last = toNum(s[s.length - 1][numericKey]);
  const prev = toNum(s[s.length - 2][numericKey]);
  if (last == null || prev == null || prev === 0) return null;
  return ((last - prev) / Math.abs(prev)) * 100;
}

/* ================================================================== *
 * Draft dialog (Gemini-drafted copy-ready text)
 * ================================================================== */

function DraftDialog({
  open, onClose, title, facts, kind,
}: {
  open: boolean; onClose: () => void; title: string;
  facts: unknown; kind: "reorder" | "email" | "summary";
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setErr(null); setText("");
    const promptByKind: Record<typeof kind, string> = {
      reorder: "Write a concise reorder list a purchase manager can copy-paste. Group by severity; keep numbers verbatim.",
      email: "Write a polite operations email requesting action on the top items. 6–10 sentences. Keep numbers verbatim.",
      summary: "Write a crisp management summary (5 sentences) of the current state and top actions. Keep numbers verbatim.",
    };
    generateGemini({
      system: [
        "You are drafting operational text from a compact FACTS JSON.",
        "Use only numbers/labels present in FACTS. Never invent or compute.",
        "Do not claim any action was taken; this is a DRAFT for a human to review.",
      ].join("\n"),
      prompt: `${promptByKind[kind]}\n\nFACTS:\n${JSON.stringify(facts)}`,
      temperature: 0.3,
    })
      .then((t) => { if (!cancelled) setText(t.trim()); })
      .catch((e) => { if (!cancelled) setErr(e?.message || "Draft failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, kind, facts]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparkleIcon className="text-primary" />
            {title}
            <Badge variant="outline" className="ml-2 text-[10px]">DRAFT</Badge>
          </DialogTitle>
        </DialogHeader>
        {loading && <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /></div>}
        {err && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}
        {!loading && !err && (
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed">
            {text}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">Drafts only — nothing is sent or applied automatically.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => { navigator.clipboard?.writeText(text); }} disabled={!text}>
            <Copy className="mr-1 h-4 w-4" /> Copy
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== *
 * Sections
 * ================================================================== */

function HeaderStrip({ data }: { data: AgenticDashboardData }) {
  const flags = data.analysis?.flags || [];
  const sa = data.analysis?.sheet_analyses?.[0];
  const modeBadge = data.analysis?.mode_badge;
  const title = data.project || "AI Insights";
  return (
    <section id="section-header">
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {modeBadge && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                <SparkleIcon className="h-3 w-3" />
                {modeBadge}
              </span>
            )}
          </div>
          {sa?.summary && <p className="text-sm text-muted-foreground">{sa.summary}</p>}
          {flags.length > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" />
              <span className="font-medium">{flags.length} {flags.length === 1 ? "issue" : "issues"} detected</span>
              <span className="text-destructive/70">— see Actions</span>
            </div>
          ) : (
            <div className="inline-flex w-fit items-center gap-2 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success">
              <CheckCircle2 className="h-3.5 w-3.5" /> No issues detected
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ExecutiveBrief({
  data, geminiBrief, geminiBullets,
}: { data: AgenticDashboardData; geminiBrief?: string; geminiBullets?: string[] }) {
  const brief = data.ai_summary?.trim() || geminiBrief?.trim();
  const bullets =
    (data.modules?.digest?.sheets?.[0]?.highlights?.filter(Boolean).slice(0, 4)) ||
    (geminiBullets?.slice(0, 4)) || [];
  if (!brief && !bullets.length) return null;
  return (
    <section id="section-brief">
      <Card className="overflow-hidden rounded-2xl border-primary/20 bg-gradient-to-br from-primary/5 via-card to-card shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <SparkleIcon className="text-primary" /> AI Insights
            </CardTitle>
            <AiTag />
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-foreground/90">
          {brief && (
            <div className="whitespace-pre-line">{brief.replace(/\.\s+Suggestion:\s*\.\s*/g, ". ").trim()}</div>
          )}
          {bullets.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-foreground/85">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function HeroKpis({
  data, trendDelta,
}: { data: AgenticDashboardData; trendDelta: number | null }) {
  const totals = data.analysis?.sheet_analyses?.[0]?.totals;
  const trendsReady = !!data.modules?.trends?.ready;
  const kpis = useMemo(() => pickHeroTotals(totals, trendsReady, trendDelta), [totals, trendsReady, trendDelta]);
  if (!kpis.length) return null;
  return (
    <section id="section-kpis" className="scroll-mt-20">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k, i) => (
          <Card key={i} className="rounded-2xl border-border/60 shadow-sm transition hover:shadow-md">
            <CardContent className="p-5">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {k.label}
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <div className="text-3xl font-bold tabular-nums tracking-tight">
                  {fmt(k.value, k.label)}
                </div>
                {k.delta != null && (
                  <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${k.delta >= 0 ? "text-success" : "text-destructive"}`}>
                    {k.delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {pct(Math.abs(k.delta))}
                  </span>
                )}
              </div>
              <AiLine severity="low">
                {k.hint || (i === 0 ? "Primary metric for this dataset." : "Reference figure from the source.")}
              </AiLine>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function ActionCard({
  action, geminiText, facts,
}: { action: Action; geminiText?: string; facts: unknown }) {
  const [draftKind, setDraftKind] = useState<null | "reorder" | "email" | "summary">(null);
  const perActionFacts = useMemo(() => ({ ...(facts as object), focus_action: action }), [facts, action]);
  return (
    <Card className={`rounded-xl border border-border/60 border-l-4 ${SEV_BORDER[action.severity]} shadow-sm`}>
      <CardContent className="flex flex-col gap-2 p-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEV_BG[action.severity]}`}>
              {action.severity}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {action.source}
            </span>
          </div>
          <div className="text-sm font-semibold leading-snug">{action.title}</div>
          {(geminiText || action.detail) && (
            <div className="mt-1 text-xs text-muted-foreground">{geminiText || action.detail}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {action.source === "Shortage" && (
            <Button variant="outline" size="sm" onClick={() => setDraftKind("reorder")}>
              <SparkleIcon /> Draft reorder
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setDraftKind("email")}>
            <SparkleIcon /> Draft email
          </Button>
        </div>
      </CardContent>
      {draftKind && (
        <DraftDialog
          open
          onClose={() => setDraftKind(null)}
          kind={draftKind}
          title={draftKind === "reorder" ? "Draft reorder list" : draftKind === "email" ? "Draft email" : "Draft summary"}
          facts={perActionFacts}
        />
      )}
    </Card>
  );
}

function NextBestActions({
  actions, geminiItems, facts,
}: { actions: Action[]; geminiItems?: Record<string, { text?: string }>; facts: unknown }) {
  const [showAll, setShowAll] = useState(false);
  const [pageDraft, setPageDraft] = useState<null | "reorder" | "email" | "summary">(null);
  if (!actions.length) return null;
  const visible = showAll ? actions : actions.slice(0, 6);
  return (
    <section id="section-actions" className="scroll-mt-20">
      <SectionTitle
        eyebrow="Agentic core"
        title="Next Best Actions"
        caption={`${actions.length} prioritized ${actions.length === 1 ? "action" : "actions"} synthesized from your data`}
        right={
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setPageDraft("reorder")}>
              <SparkleIcon /> Draft reorder list
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPageDraft("email")}>
              <SparkleIcon /> Draft email
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPageDraft("summary")}>
              <SparkleIcon /> Copy summary
            </Button>
          </div>
        }
      />
      <div className="grid gap-2.5">
        {visible.map((a) => (
          <ActionCard key={a.id} action={a} geminiText={geminiItems?.[a.id]?.text} facts={facts} />
        ))}
      </div>
      {actions.length > 6 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show fewer" : `Show all ${actions.length}`}
          <ChevronDown className={`ml-1 h-4 w-4 transition ${showAll ? "rotate-180" : ""}`} />
        </Button>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Drafts only — nothing is sent or applied automatically.
      </p>
      {pageDraft && (
        <DraftDialog
          open
          onClose={() => setPageDraft(null)}
          kind={pageDraft}
          title={pageDraft === "reorder" ? "Draft reorder list" : pageDraft === "email" ? "Draft email" : "Copy summary"}
          facts={facts}
        />
      )}
    </section>
  );
}

/* ---------- Section-scoped Next Best Actions strip ---------- */

function SectionActions({
  actions, facts, geminiItems, title = "Next best actions",
  emptyText = "No actions in this area.", max = 4,
}: {
  actions: Action[];
  facts: unknown;
  geminiItems?: Record<string, { text?: string }>;
  title?: string;
  emptyText?: string;
  max?: number;
}) {
  const [draft, setDraft] = useState<null | { kind: "reorder" | "email" | "summary"; facts: unknown; title: string }>(null);
  const [showAll, setShowAll] = useState(false);
  if (!actions.length) {
    return (
      <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <SparkleIcon className="h-3 w-3 text-primary" /> {emptyText}
      </div>
    );
  }
  const visible = showAll ? actions : actions.slice(0, max);
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          <SparkleIcon className="h-3 w-3 text-primary" /> {title}
        </div>
        <Badge variant="outline" className="text-[10px]">{actions.length}</Badge>
      </div>
      <ul className="space-y-1.5">
        {visible.map((a) => (
          <li
            key={a.id}
            className={`flex items-start justify-between gap-2 rounded-md border border-border/60 bg-card px-2.5 py-1.5 border-l-4 ${SEV_BORDER[a.severity]}`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[a.severity]}`} />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{a.source}</span>
              </div>
              <div className="mt-0.5 truncate text-xs font-medium">{a.title}</div>
              {(geminiItems?.[a.id]?.text || a.detail) && (
                <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                  {geminiItems?.[a.id]?.text || a.detail}
                </div>
              )}
            </div>
            <Button
              variant="ghost" size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() =>
                setDraft({
                  kind: a.source === "Shortage" ? "reorder" : "email",
                  title: a.source === "Shortage" ? "Draft reorder" : "Draft email",
                  facts: { ...(facts as object), focus_action: a },
                })
              }
            >
              <SparkleIcon /> Draft
            </Button>
          </li>
        ))}
      </ul>
      {actions.length > max && (
        <Button
          variant="ghost" size="sm"
          className="mt-1 h-7 text-[11px]"
          onClick={() => setShowAll((s) => !s)}
        >
          {showAll ? "Show fewer" : `Show all ${actions.length}`}
          <ChevronDown className={`ml-1 h-3.5 w-3.5 transition ${showAll ? "rotate-180" : ""}`} />
        </Button>
      )}
      {draft && (
        <DraftDialog
          open onClose={() => setDraft(null)}
          kind={draft.kind} title={draft.title} facts={draft.facts}
        />
      )}
    </div>
  );
}

/* ---------- Pivot chart + Risk feed ---------- */

function pivotFocusActions(pivot?: Pivot): Action[] {
  const rows = pivot?.data || [];
  if (!rows.length) return [];
  const total = pivot?.total ?? rows.reduce((s, r) => s + (toNum(r.value) || 0), 0);
  const dim = pivot?.dimension || "dimension";
  const meas = pivot?.measure || "value";
  return rows.slice(0, 3).map((r, i) => {
    const v = toNum(r.value) || 0;
    const share = total ? (v / total) * 100 : 0;
    const sev: Severity = share >= 40 ? "medium" : "low";
    return {
      id: `pivot-${i}`,
      source: "Recommendation",
      severity: sev,
      title: `Review ${r.key} (${dim})`,
      detail: `${fmt(v, meas)} ${meas}${share > 0 ? ` — ${pct(share)} of total` : ""}`,
    };
  });
}

function PivotChartCard({
  base, initial, facts, geminiItems,
}: {
  base: string; initial?: Pivot;
  facts?: unknown; geminiItems?: Record<string, { text?: string }>;
}) {
  const [dim, setDim] = useState<string | undefined>(initial?.dimension);
  const [meas, setMeas] = useState<string | undefined>(initial?.measure);
  const fetchUrl = useServerFn(fetchInsightUrl);
  const dims = initial?.available_dimensions || [];
  const measures = initial?.available_measures || [];

  useEffect(() => { setDim(initial?.dimension); setMeas(initial?.measure); }, [initial?.dimension, initial?.measure]);

  const q = useQuery({
    queryKey: ["pivot", base, dim, meas],
    enabled: !!base && !!dim && !!meas && (dim !== initial?.dimension || meas !== initial?.measure),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const url = `${base}/dashboard?fields=pivot&dimension=${encodeURIComponent(dim!)}&measure=${encodeURIComponent(meas!)}`;
      const res = await fetchUrl({ data: { url } });
      return (res.payload as { modules?: { pivot?: Pivot } })?.modules?.pivot;
    },
  });
  const pivot = q.data || initial;
  const rows = (pivot?.data || []).slice(0, 12);
  const total = pivot?.total ?? rows.reduce((s, r) => s + (toNum(r.value) || 0), 0);
  const top = rows[0];
  const caption =
    top && total
      ? `${top.key} drives ${pct((toNum(top.value) || 0) / total * 100)} of ${pivot?.measure}`
      : `${pivot?.measure || "measure"} by ${pivot?.dimension || "dimension"}`;

  if (!rows.length) return null;
  return (
    <Card className="rounded-2xl border-border/60 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Breakdown</div>
            <CardTitle className="mt-0.5 truncate text-base font-semibold">
              {pivot?.measure} by {pivot?.dimension}
            </CardTitle>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <SparkleIcon className="h-3 w-3 text-primary" /> {caption}
            </div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {dims.length > 1 && (
              <Select value={dim} onValueChange={setDim}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Dimension" /></SelectTrigger>
                <SelectContent>{dims.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {measures.length > 1 && (
              <Select value={meas} onValueChange={setMeas}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Measure" /></SelectTrigger>
                <SelectContent>{measures.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis type="number" tickFormatter={(v) => fmt(v)} tick={{ fontSize: 11 }} />
              <YAxis dataKey="key" type="category" width={120} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => fmt(v, pivot?.measure)} cursor={{ fill: "var(--accent)" }} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                {rows.map((_, i) => (
                  <Cell key={i} fill={i < 3 ? "var(--chart-1)" : "var(--chart-5)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
          </ResponsiveContainer>
        </div>
        {facts && (
          <SectionActions
            title="Focus these first"
            actions={pivotFocusActions(pivot)}
            facts={facts}
            geminiItems={geminiItems}
            emptyText="No standout drivers detected."
            max={3}
          />
        )}
      </CardContent>
    </Card>
  );
}

function RiskFeed({
  anomalies, actions = [], facts, geminiItems,
}: {
  anomalies: Anomaly[]; actions?: Action[];
  facts?: unknown; geminiItems?: Record<string, { text?: string }>;
}) {
  if (!anomalies.length) return null;
  const top = anomalies.slice(0, 6);
  return (
    <Card className="rounded-2xl border-border/60 shadow-sm">
      <CardHeader className="pb-2">
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-warning">Risk</div>
        <CardTitle className="text-base font-semibold">Anomalies</CardTitle>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <SparkleIcon className="h-3 w-3 text-primary" /> {anomalies.length} outliers, largest {top[0]?.label ?? "row"}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {top.map((a, i) => {
            const score = a.score != null ? `${Number(a.score).toFixed(1)}×` : "";
            return (
              <li key={i} className="flex items-start gap-2 rounded-lg border border-border/60 p-2.5">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_DOT.high}`} />
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium">{a.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.column && <span>{a.column} = </span>}
                    <span className="font-mono">{fmt(a.value)}</span>
                    {score && <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">{score}</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/* ---------- Inventory signals ---------- */

function RankedBars({
  data, measureLabel, tone = "neutral",
}: { data: StockData[]; measureLabel?: string; tone?: "neutral" | "danger" }) {
  const total = data.reduce((s, d) => s + Math.abs(toNum(d.value) || 0), 0);
  const max = Math.max(...data.map((d) => Math.abs(toNum(d.value) || 0))) || 1;
  return (
    <ul className="space-y-2.5">
      {data.slice(0, 8).map((d, i) => {
        const v = toNum(d.value) || 0;
        const width = (Math.abs(v) / max) * 100;
        const isDanger = tone === "danger" || v < 0;
        const share = total ? (Math.abs(v) / total) * 100 : 0;
        return (
          <li key={`${d.key}-${i}`}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="truncate pr-2 font-medium">{d.key}</span>
              <span className={`font-mono tabular-nums ${isDanger ? "text-destructive" : "text-foreground"}`}>
                {fmt(v, measureLabel)}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted">
              <div
                className={`h-2 rounded-full ${isDanger ? "bg-destructive" : "bg-primary"}`}
                style={{ width: `${width}%` }}
              />
            </div>
            {i < 3 && !isDanger && share > 0 && (
              <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <SparkleIcon className="h-2.5 w-2.5 text-primary" /> {pct(share)} of total
              </div>
            )}
            {isDanger && (
              <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                Reorder soon
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function InventorySection({ stock }: { stock: StockViews }) {
  const top = stock.top_consumers?.data || [];
  const low = stock.low_balance?.data || [];
  if (!top.length && !low.length) return null;
  return (
    <section id="section-inventory" className="scroll-mt-20">
      <SectionTitle eyebrow="Inventory" title="Stock signals" caption="Live consumption and shortages, sorted by impact" />
      <div className="grid gap-4 md:grid-cols-2">
        {top.length > 0 && (
          <Card className="rounded-2xl border-border/60 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold">Top consumers</CardTitle>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <SparkleIcon className="h-3 w-3 text-primary" /> by {stock.top_consumers?.measure}
              </div>
            </CardHeader>
            <CardContent><RankedBars data={top} measureLabel={stock.top_consumers?.measure} /></CardContent>
          </Card>
        )}
        {low.length > 0 && (
          <Card className="rounded-2xl border-border/60 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold">Shortages / Low stock</CardTitle>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <SparkleIcon className="h-3 w-3 text-primary" />
                {low.filter((x) => x.value <= 0).length} items short by cumulative {fmt(low.reduce((s, x) => s + (x.value < 0 ? Math.abs(x.value) : 0), 0), stock.low_balance?.measure)}
              </div>
            </CardHeader>
            <CardContent><RankedBars data={low} measureLabel={stock.low_balance?.measure} tone="danger" /></CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}

/* ---------- Item table ---------- */

const HELPER_KEYS = new Set([
  "available_dimensions", "available_measures", "available_sheets", "available_columns",
  "available_dates", "delta_pct", "delta", "enabled", "numeric_sums", "column_roles",
]);

function ItemTable({ sheet, anomalies }: { sheet: SheetLite; anomalies: Anomaly[] }) {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const anomalySet = useMemo(
    () => new Set((anomalies || []).map((a) => (a.label || "").toLowerCase())),
    [anomalies],
  );
  const { balanceCol, consumptionCol, keyCol } = useMemo(() => inventoryColumns(sheet), [sheet]);
  const isInv = !!balanceCol;

  const rows = sheet.rows || [];
  const cols = (sheet.columns?.map((c) => c.name) || Object.keys(rows[0] || {}))
    .filter((c) => !HELPER_KEYS.has(c));

  const primaryCols = [keyCol, balanceCol, consumptionCol].filter(Boolean) as string[];
  const showCols = primaryCols.length >= 2
    ? primaryCols
    : cols.slice(0, 4);

  const scored = useMemo(() => rows.map((r) => ({
    row: r,
    rec: isInv
      ? recommendationForInventoryRow(r, sheet)
      : recommendationForGenericRow(r, sheet, anomalySet),
  })), [rows, isInv, sheet, anomalySet]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return scored;
    return scored.filter(({ row }) => showCols.some((c) => String(row[c] ?? "").toLowerCase().includes(s)));
  }, [q, scored, showCols]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => SEV_RANK[a.rec.severity] - SEV_RANK[b.rec.severity]),
    [filtered],
  );
  const visible = showAll ? sorted : sorted.slice(0, 10);

  if (!rows.length) return null;
  return (
    <section id="section-items" className="scroll-mt-20">
      <SectionTitle
        eyebrow="Detail"
        title={`${sheet.label || sheet.name || "Items"}`}
        caption={`${sorted.length} of ${rows.length} rows — status derived from real values`}
        right={
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-8 w-48"
          />
        }
      />
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {showCols.map((c) => <TableHead key={c}>{c}</TableHead>)}
                <TableHead>Status</TableHead>
                <TableHead className="w-[36%]">
                  <span className="inline-flex items-center gap-1">
                    <SparkleIcon className="h-3 w-3 text-primary" /> AI Suggestion
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map(({ row, rec }, i) => (
                <TableRow key={i}>
                  {showCols.map((c) => (
                    <TableCell key={c} className={/qty|value|amount|balance|consumption|issued|rate/i.test(c) ? "font-mono tabular-nums" : ""}>
                      {typeof row[c] === "number" ? fmt(row[c], c) : String(row[c] ?? "—")}
                    </TableCell>
                  ))}
                  <TableCell>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEV_BG[rec.severity]}`}>
                      {SEV_PILL_LABEL[rec.severity]}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <span className="inline-flex items-start gap-1.5">
                      <SparkleIcon className={`mt-0.5 h-3 w-3 ${SEV_TEXT[rec.severity]}`} />
                      {rec.text}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {sorted.length > 10 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show top 10" : `Show all ${sorted.length}`}
          <ChevronDown className={`ml-1 h-4 w-4 transition ${showAll ? "rotate-180" : ""}`} />
        </Button>
      )}
    </section>
  );
}

/* ---------- Data quality ---------- */

function QualityGauge({ score }: { score: number }) {
  const clamped = Math.max(0, Math.min(100, score));
  const color =
    clamped >= 85 ? "var(--success)" : clamped >= 60 ? "var(--warning)" : "var(--destructive)";
  const c = 2 * Math.PI * 44;
  const dash = (clamped / 100) * c;
  return (
    <div className="relative grid place-items-center">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="44" fill="none" stroke="var(--muted)" strokeWidth="10" />
        <circle
          cx="60" cy="60" r="44" fill="none" stroke={color} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 60 60)"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-3xl font-bold tabular-nums" style={{ color }}>{Math.round(clamped)}</div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">score</div>
      </div>
    </div>
  );
}
function QualitySection({ quality }: { quality: Quality }) {
  const q = quality.sheets?.[0];
  if (!q) return null;
  const issues = q.issues || [];
  return (
    <section id="section-quality" className="scroll-mt-20">
      <SectionTitle eyebrow="Data health" title="Data quality" caption={`Score ${q.score}/100 — ${issues[0] ? `fix ${issues[0].slice(0, 60)}${issues[0].length > 60 ? "…" : ""} first` : "no issues logged"}`} />
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="grid gap-6 p-5 md:grid-cols-[auto_1fr]">
          <QualityGauge score={q.score ?? 0} />
          <div className="min-w-0">
            {issues.length > 0 ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {issues.slice(0, 12).map((i, idx) => (
                    <span key={idx} className="inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs">
                      {i}
                    </span>
                  ))}
                </div>
                <div className="mt-4">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Fix these first</div>
                  <ol className="mt-2 space-y-1 text-sm">
                    {issues.slice(0, 3).map((i, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-warning/15 text-[10px] font-bold text-warning">{idx + 1}</span>
                        {i}
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" /> No issues logged.
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ---------- Trends ---------- */

function TrendsSection({ trends }: { trends: Trends }) {
  if (!trends.ready || !trends.series?.length) return null;
  const series = trends.series as Record<string, unknown>[];
  const keys = Object.keys(series[0]).filter((k) => k !== "date" && series.some((r) => toNum(r[k]) != null));
  if (!keys.length) return null;
  const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-5)"];
  return (
    <section id="section-trends" className="scroll-mt-20">
      <SectionTitle eyebrow="Trend" title="Over time" caption={`${series.length} snapshots — ${keys.length} tracked ${keys.length === 1 ? "metric" : "metrics"}`} />
      <Card className="rounded-2xl border-border/60 shadow-sm">
        <CardContent className="p-5">
          <div className="h-[280px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => fmt(v)} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => fmt(v)} />
                {keys.slice(0, 4).map((k, i) => (
                  <Line key={k} type="monotone" dataKey={k} stroke={colors[i % colors.length]} strokeWidth={2} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

/* ================================================================== *
 * Main component
 * ================================================================== */

export function computeAgenticTabs(data: AgenticDashboardData) {
  return {
    inventory: !!data.modules?.stock_views?.enabled,
    anomalies: (data.modules?.anomalies?.count ?? 0) > 0,
    actions: (data.modules?.recommendations?.recommendations?.length ?? 0) > 0
      || (data.analysis?.flags?.length ?? 0) > 0
      || (data.modules?.anomalies?.count ?? 0) > 0
      || ((data.modules?.stock_views?.low_balance?.data || []).some((s) => s.value <= 0)),
    quality: (data.modules?.data_quality?.sheets?.length ?? 0) > 0,
    trends: !!data.modules?.trends?.ready,
  };
}

export default function AgenticInsightsOverview({
  data, base, onRefresh, refreshing, scrollTo,
}: {
  data: AgenticDashboardData;
  base?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  scrollTo?: string;
}) {
  useEffect(() => {
    if (!scrollTo) return;
    const id = window.setTimeout(() => {
      document.getElementById(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [scrollTo]);

  const actions = useMemo(() => buildActions(data), [data]);
  const facts = useMemo(() => buildFacts(data, actions), [data, actions]);
  const gemini = useGroundedGemini(facts, actions.length > 0 || !!data.analysis?.sheet_analyses?.length);
  const trendDelta = useMemo(() => computeTrendDelta(data.modules?.trends), [data.modules?.trends]);

  const sheet = data.sheets?.[0];
  const anomalies = data.modules?.anomalies?.anomalies || [];
  const stock = data.modules?.stock_views;
  const pivot = data.modules?.pivot;
  const quality = data.modules?.data_quality;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        {onRefresh && (
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCcw className={`mr-1 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        )}
      </div>

      <HeaderStrip data={data} />
      <ExecutiveBrief data={data} geminiBrief={gemini.data?.brief} geminiBullets={gemini.data?.bullets} />
      <HeroKpis data={data} trendDelta={trendDelta} />
      <NextBestActions actions={actions} geminiItems={gemini.data?.items} facts={facts} />

      {(pivot?.data?.length || anomalies.length > 0) && (
        <section id="section-breakdown" className="scroll-mt-20">
          <div className="grid gap-4 lg:grid-cols-3">
            {pivot?.data?.length ? (
              <div className="lg:col-span-2">
                {base ? <PivotChartCard base={base} initial={pivot} /> : null}
              </div>
            ) : null}
            {anomalies.length > 0 && (
              <div className={pivot?.data?.length ? "" : "lg:col-span-3"}>
                <RiskFeed anomalies={anomalies} />
              </div>
            )}
          </div>
        </section>
      )}

      {stock?.enabled && <InventorySection stock={stock} />}
      {sheet && <ItemTable sheet={sheet} anomalies={anomalies} />}
      {quality && <QualitySection quality={quality} />}
      {data.modules?.trends && <TrendsSection trends={data.modules.trends} />}

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <ChevronDown className="mr-1 h-3.5 w-3.5" /> Inspect raw payload
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          <pre className="max-h-[420px] overflow-auto rounded-lg border bg-muted/40 p-3 text-[10px] leading-tight">
            {JSON.stringify(data, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
