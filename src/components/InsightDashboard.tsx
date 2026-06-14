import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronDown, Send, Sparkles } from "lucide-react";

/* ------------------------------- Types ------------------------------- */

type Column = { name: string; type?: string; distinct?: number };
type KPI = { label: string; value: number | string };
type Chart = {
  type?: string;
  title: string;
  x?: string;
  y?: string;
  data: { name: string; value: number }[];
};
type Sheet = {
  label: string;
  name?: string;
  color?: string;
  row_count?: number;
  columns?: Column[];
  kpis?: KPI[];
  charts?: Chart[];
  rows?: Record<string, unknown>[];
};
type Flag = { message?: string; title?: string; severity?: string };
type Analysis = {
  summary?: string;
  totals?: Record<string, number>;
  status_breakdown?: Record<string, number>;
  flags?: Flag[];
  mode_badge?: string;
  copilot_enabled?: boolean;
  risk_score?: number | Record<string, unknown>;
  top_delay_reasons?: unknown[];
  person_ranking?: unknown[];
  department_ranking?: unknown[];
  tat_performance?: unknown[];
  correlation_matrix?: unknown;
  timeline_correlation?: unknown;
  dependency_chains?: unknown;
  variance?: unknown;
  [k: string]: unknown;
};
type Modules = {
  data_quality?: { score?: number; issues?: unknown[] };
  pivot?: unknown;
  anomalies?: unknown;
  forecast?: unknown;
  trends?: unknown;
  whatif?: unknown;
  digest?: string | { text?: string };
  recommendations?: (string | { title?: string; detail?: string })[];
  [k: string]: unknown;
};
type DashboardData = {
  enabled?: boolean;
  project?: string;
  enabled_fields?: string[];
  data_dashboard_enabled?: boolean;
  sheets?: Sheet[];
  analysis?: Analysis;
  modules?: Modules;
  [k: string]: unknown;
};

type ChatMsg = { role: "user" | "assistant"; text: string };

const STARTERS = [
  "Summarize this sheet in 3 points",
  "Which category has the highest total?",
  "Any data-quality issues?",
];

const HANDLED_TOP_KEYS = new Set([
  "enabled",
  "project",
  "enabled_fields",
  "data_dashboard_enabled",
  "sheets",
  "analysis",
  "modules",
]);
const HANDLED_ANALYSIS_KEYS = new Set([
  "summary",
  "totals",
  "status_breakdown",
  "flags",
  "mode_badge",
  "copilot_enabled",
  "risk_score",
  "top_delay_reasons",
  "person_ranking",
  "department_ranking",
  "tat_performance",
  "correlation_matrix",
  "timeline_correlation",
  "dependency_chains",
  "variance",
]);
const HANDLED_MODULES_KEYS = new Set([
  "data_quality",
  "pivot",
  "anomalies",
  "forecast",
  "trends",
  "whatif",
  "digest",
  "recommendations",
]);

/* ------------------------------ Helpers ------------------------------ */

function fmtNum(v: unknown) {
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  return String(v ?? "");
}
function fmtCell(v: unknown) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

function normalizeBase(raw: string): { base: string; error?: string } {
  let s = raw.trim();
  if (!s) return { base: "", error: "Enter a full URL starting with https://" };
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/(dashboard|copilot|export)\/?$/i, "");
  s = s.replace(/\/+$/, "");
  if (!/^https:\/\//i.test(s)) {
    return { base: "", error: "Enter a full URL starting with https://" };
  }
  try {
    const u = new URL(s);
    if (!u.host) throw new Error("no host");
  } catch {
    return { base: "", error: "Enter a full URL starting with https://" };
  }
  return { base: s };
}

/* --------------------------- Generic renderers ----------------------- */

function KVList({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  if (!entries.length) return null;
  return (
    <dl className="divide-y divide-border text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-3 py-1.5">
          <dt className="col-span-1 text-muted-foreground">{k}</dt>
          <dd className="col-span-2 break-words">
            {v === null || v === undefined ? (
              <span className="text-muted-foreground">—</span>
            ) : typeof v === "object" ? (
              <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-xs">
                {JSON.stringify(v, null, 2)}
              </pre>
            ) : (
              fmtCell(v)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ObjectArrayTable({
  rows,
  maxRows = 200,
}: {
  rows: Record<string, unknown>[];
  maxRows?: number;
}) {
  const cols = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => Object.keys(r || {}).forEach((k) => set.add(k)));
    return Array.from(set);
  }, [rows]);
  return (
    <ScrollArea className="max-h-96 w-full">
      <Table>
        <TableHeader>
          <TableRow>
            {cols.map((c) => (
              <TableHead key={c}>{c}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.slice(0, maxRows).map((r, i) => (
            <TableRow key={i}>
              {cols.map((c) => (
                <TableCell key={c} className="whitespace-nowrap">
                  {fmtCell(r?.[c])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function ChipList({ items }: { items: unknown[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((v, i) => (
        <Badge key={i} variant="secondary" className="font-normal">
          {fmtCell(v)}
        </Badge>
      ))}
    </div>
  );
}

function GenericValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <div className="text-sm">{fmtCell(value)}</div>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="text-sm text-muted-foreground">Empty</div>;
    if (value.every((v) => isPlainObject(v))) {
      return <ObjectArrayTable rows={value as Record<string, unknown>[]} />;
    }
    if (value.every((v) => typeof v !== "object" || v === null)) {
      return <ChipList items={value} />;
    }
    return (
      <pre className="overflow-x-auto rounded bg-muted/40 p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  if (isPlainObject(value)) {
    return <KVList obj={value} />;
  }
  return null;
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/* ------------------------ Specialized renderers ---------------------- */

function KPICardSmall({ label, value }: { label: string; value: unknown }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{fmtNum(value)}</div>
      </CardContent>
    </Card>
  );
}

function RankedTable({ data }: { data: unknown[] }) {
  if (!Array.isArray(data) || data.length === 0) return null;
  if (!data.every(isPlainObject)) return <GenericValue value={data} />;
  const rows = data as Record<string, unknown>[];
  // pick the first numeric column as sort key
  const numericKey = (() => {
    for (const k of Object.keys(rows[0])) {
      if (typeof rows[0][k] === "number") return k;
    }
    return null;
  })();
  const sorted = numericKey
    ? [...rows].sort((a, b) => Number(b[numericKey]) - Number(a[numericKey]))
    : rows;
  return <ObjectArrayTable rows={sorted} />;
}

function CorrelationMatrix({ data }: { data: unknown }) {
  // Accept shape: { labels: string[], matrix: number[][] } OR { [row]: { [col]: number } }
  let labels: string[] = [];
  let matrix: number[][] = [];
  if (isPlainObject(data) && Array.isArray((data as any).labels) && Array.isArray((data as any).matrix)) {
    labels = (data as any).labels as string[];
    matrix = (data as any).matrix as number[][];
  } else if (isPlainObject(data)) {
    const rowKeys = Object.keys(data);
    const colSet = new Set<string>();
    rowKeys.forEach((rk) => {
      const r = (data as any)[rk];
      if (isPlainObject(r)) Object.keys(r).forEach((c) => colSet.add(c));
    });
    labels = Array.from(new Set([...rowKeys, ...colSet]));
    matrix = rowKeys.map((rk) =>
      labels.map((c) => {
        const r = (data as any)[rk];
        const v = isPlainObject(r) ? r[c] : undefined;
        return typeof v === "number" ? v : NaN;
      }),
    );
  } else {
    return <GenericValue value={data} />;
  }

  return (
    <ScrollArea className="max-h-96 w-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead></TableHead>
            {labels.map((l) => (
              <TableHead key={l}>{l}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {matrix.map((row, i) => (
            <TableRow key={i}>
              <TableCell className="font-medium">{labels[i] ?? `r${i}`}</TableCell>
              {row.map((v, j) => {
                const ok = Number.isFinite(v);
                const intensity = ok ? Math.min(1, Math.abs(v)) : 0;
                const bg = ok
                  ? v >= 0
                    ? `hsl(var(--primary) / ${intensity * 0.35})`
                    : `hsl(var(--destructive) / ${intensity * 0.35})`
                  : undefined;
                return (
                  <TableCell key={j} style={{ backgroundColor: bg }} className="tabular-nums">
                    {ok ? v.toFixed(2) : "—"}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

function SeriesData(val: unknown): { name: string; value: number }[] | null {
  if (Array.isArray(val) && val.length && val.every(isPlainObject)) {
    const rows = val as Record<string, unknown>[];
    const keys = Object.keys(rows[0]);
    const nameKey = keys.find((k) => typeof rows[0][k] === "string") || keys[0];
    const valKey = keys.find((k) => k !== nameKey && typeof rows[0][k] === "number");
    if (nameKey && valKey) {
      return rows.map((r) => ({
        name: String(r[nameKey]),
        value: Number(r[valKey]) || 0,
      }));
    }
  }
  if (isPlainObject(val)) {
    // try { series: [...] } or { data: [...] }
    const inner = (val as any).series ?? (val as any).data ?? (val as any).points;
    if (inner) return SeriesData(inner);
  }
  return null;
}

function LineSeries({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Line
            type="monotone"
            dataKey="value"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BarSeries({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RiskScore({ value }: { value: unknown }) {
  let score: number | null = null;
  if (typeof value === "number") score = value;
  else if (isPlainObject(value) && typeof (value as any).score === "number")
    score = (value as any).score;
  if (score === null) return <GenericValue value={value} />;
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-6">
      <div>
        <div className="text-4xl font-semibold tabular-nums">{score}</div>
        <div className="text-xs text-muted-foreground">Risk score</div>
      </div>
      <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
        <div
          className="h-full bg-primary"
          style={{ width: `${pct}%` }}
        />
      </div>
      {isPlainObject(value) && (
        <div className="text-xs text-muted-foreground">
          <KVList obj={value as Record<string, unknown>} />
        </div>
      )}
    </div>
  );
}

function DependencyChains({ data }: { data: unknown }) {
  const render = (v: unknown, depth = 0): React.ReactNode => {
    if (Array.isArray(v)) {
      return (
        <ul className="ml-4 list-disc space-y-1">
          {v.map((x, i) => (
            <li key={i}>{render(x, depth + 1)}</li>
          ))}
        </ul>
      );
    }
    if (isPlainObject(v)) {
      const entries = Object.entries(v);
      return (
        <ul className="ml-4 list-disc space-y-1">
          {entries.map(([k, val]) => (
            <li key={k}>
              <span className="font-medium">{k}</span>
              {typeof val === "object" && val !== null ? render(val, depth + 1) : (
                <>: <span>{fmtCell(val)}</span></>
              )}
            </li>
          ))}
        </ul>
      );
    }
    return <span>{fmtCell(v)}</span>;
  };
  return <div className="text-sm">{render(data)}</div>;
}

function Recommendations({ items }: { items: Modules["recommendations"] }) {
  if (!items?.length) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((it, i) => {
        if (typeof it === "string") return <li key={i}>{it}</li>;
        return (
          <li key={i}>
            {it.title && <span className="font-medium">{it.title}</span>}
            {it.title && it.detail ? " — " : ""}
            {it.detail}
          </li>
        );
      })}
    </ul>
  );
}

function DataQuality({ dq }: { dq: NonNullable<Modules["data_quality"]> }) {
  return (
    <div className="space-y-3">
      {typeof dq.score === "number" && (
        <div className="flex items-baseline gap-2">
          <div className="text-3xl font-semibold tabular-nums">{dq.score}</div>
          <div className="text-xs text-muted-foreground">quality score</div>
        </div>
      )}
      {Array.isArray(dq.issues) && dq.issues.length > 0 && (
        <GenericValue value={dq.issues} />
      )}
    </div>
  );
}

function ForecastOrTrend({ data, label }: { data: unknown; label: string }) {
  const series = SeriesData(data);
  if (series) return <LineSeries data={series} />;
  if (isPlainObject(data) && typeof (data as any).message === "string") {
    return <div className="text-sm text-muted-foreground">{(data as any).message}</div>;
  }
  return <GenericValue value={data} />;
}

function Anomalies({ data }: { data: unknown }) {
  if (Array.isArray(data) && data.every(isPlainObject)) {
    return <ObjectArrayTable rows={data as Record<string, unknown>[]} />;
  }
  return <GenericValue value={data} />;
}

function WhatIf({ data }: { data: unknown }) {
  const series = SeriesData(data);
  if (series) return <BarSeries data={series} />;
  return <GenericValue value={data} />;
}

function Pivot({ data }: { data: unknown }) {
  const series = SeriesData(data);
  if (series) return <BarSeries data={series} />;
  if (Array.isArray(data) && data.every(isPlainObject)) {
    return <ObjectArrayTable rows={data as Record<string, unknown>[]} />;
  }
  if (isPlainObject(data) && Array.isArray((data as any).rows)) {
    return <ObjectArrayTable rows={(data as any).rows as Record<string, unknown>[]} />;
  }
  return <GenericValue value={data} />;
}

function Digest({ data }: { data: Modules["digest"] }) {
  if (!data) return null;
  if (typeof data === "string") return <p className="text-sm whitespace-pre-wrap">{data}</p>;
  if (typeof data === "object" && typeof (data as any).text === "string") {
    return <p className="text-sm whitespace-pre-wrap">{(data as any).text}</p>;
  }
  return <GenericValue value={data} />;
}

function TimelineCorrelation({ data }: { data: unknown }) {
  const series = SeriesData(data);
  if (series) return <LineSeries data={series} />;
  return <GenericValue value={data} />;
}

/* ------------------------------ Sheet view --------------------------- */

function SheetView({ sheet }: { sheet: Sheet }) {
  const cols = sheet.columns ?? [];
  return (
    <div className="space-y-4">
      {!!sheet.kpis?.length && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {sheet.kpis.map((k, i) => (
            <KPICardSmall key={i} label={k.label} value={k.value} />
          ))}
        </div>
      )}
      {!!sheet.charts?.length && (
        <div className="grid gap-4 lg:grid-cols-2">
          {sheet.charts.map((c, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle className="text-sm">{c.title}</CardTitle>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={c.data}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {sheet.label}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {sheet.row_count?.toLocaleString?.() ?? sheet.rows?.length ?? 0} rows
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-96 w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  {cols.map((c) => (
                    <TableHead key={c.name}>
                      <div className="flex items-center gap-1.5">
                        <span>{c.name}</span>
                        {c.type && (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            {c.type}
                          </Badge>
                        )}
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.rows?.slice(0, 200).map((row, ri) => (
                  <TableRow key={ri}>
                    {cols.map((c) => (
                      <TableCell key={c.name} className="whitespace-nowrap">
                        {fmtCell(row[c.name])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------ Copilot ------------------------------ */

function CopilotCard({ base, sheetLabel }: { base: string; sheetLabel: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setErr(null);
  }, [sheetLabel, base]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setErr(null);
    setMessages((m) => [...m, { role: "user", text: trimmed }]);
    setInput("");
    setThinking(true);
    try {
      const url = `${base}/copilot?sheet=${encodeURIComponent(sheetLabel)}`;
      const r = await fetch(url, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { answer?: string };
      setMessages((m) => [...m, { role: "assistant", text: j.answer || "(no answer)" }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setThinking(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          Copilot — {sheetLabel}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          ref={scrollRef}
          className="h-80 space-y-3 overflow-y-auto rounded-md border border-border bg-muted/30 p-3"
        >
          {messages.length === 0 && !thinking && (
            <p className="text-sm text-muted-foreground">Ask anything about this sheet.</p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-background"
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}
          {thinking && (
            <div className="flex justify-start">
              <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          )}
        </div>

        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <Button key={s} size="sm" variant="outline" onClick={() => send(s)} disabled={thinking}>
                {s}
              </Button>
            ))}
          </div>
        )}

        {err && <p className="text-xs text-destructive">{err}</p>}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about this sheet…"
            disabled={thinking}
          />
          <Button type="submit" disabled={thinking || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------- Main -------------------------------- */

export default function InsightDashboard() {
  const [linkInput, setLinkInput] = useState("");
  const [base, setBase] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);

  // Pre-fill from ?link= and auto-load
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const link = params.get("link");
    if (link) {
      setLinkInput(link);
      const { base: n, error: err } = normalizeBase(link);
      if (n) setBase(n);
      else setError(err || null);
    }
  }, []);

  useEffect(() => {
    if (!base) return;
    let cancel = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`${base}/dashboard`, { credentials: "omit" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: DashboardData) => {
        if (cancel) return;
        setData(j);
        const first = j?.sheets?.[0]?.label ?? null;
        setSelectedSheet(first);
      })
      .catch((e) => {
        if (cancel) return;
        const msg = e?.message || "Failed to load";
        setError(
          msg === "Failed to fetch"
            ? 'Failed to fetch — the source app likely still has Deployment Protection on.'
            : msg,
        );
      })
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [base]);

  function load() {
    const { base: n, error: err } = normalizeBase(linkInput);
    if (!n) {
      setError(err || "Enter a full URL starting with https://");
      return;
    }
    setError(null);
    setBase(n);
  }

  const analysis = data?.analysis ?? {};
  const modules = data?.modules ?? {};
  const sheets = data?.sheets ?? [];
  const currentSheet =
    sheets.find((s) => s.label === selectedSheet) ?? sheets[0] ?? null;

  // Catch-all keys
  const extraTopKeys = data
    ? Object.keys(data).filter((k) => !HANDLED_TOP_KEYS.has(k))
    : [];
  const extraAnalysisKeys = Object.keys(analysis).filter(
    (k) => !HANDLED_ANALYSIS_KEYS.has(k),
  );
  const extraModuleKeys = Object.keys(modules).filter(
    (k) => !HANDLED_MODULES_KEYS.has(k),
  );
  const hasExtras =
    extraTopKeys.length > 0 || extraAnalysisKeys.length > 0 || extraModuleKeys.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Insights</h1>
        <p className="text-sm text-muted-foreground">
          Paste any public API link to render its live dashboard.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              load();
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <Input
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="https://example.com/api/public/<token>"
              aria-label="API link"
            />
            <Button type="submit">Load</Button>
          </form>
          {base && (
            <p className="mt-2 break-all text-xs text-muted-foreground">Base: {base}</p>
          )}
        </CardContent>
      </Card>

      {loading && (
        <div className="space-y-4">
          <Skeleton className="h-10 w-72" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-72" />
        </div>
      )}

      {!loading && error && (
        <Card>
          <CardContent className="p-6 text-destructive">{error}</CardContent>
        </Card>
      )}

      {!loading && data && data.enabled === false && (
        <Card>
          <CardContent className="p-6 text-muted-foreground">
            Insights are disabled for this link.
          </CardContent>
        </Card>
      )}

      {!loading && data && data.enabled !== false && (
        <>
          {/* 1. Header */}
          <div className="flex flex-wrap items-center gap-3">
            {data.project && (
              <h2 className="text-lg font-medium">{data.project}</h2>
            )}
            {analysis.mode_badge && (
              <Badge variant="secondary" className="font-normal">
                {analysis.mode_badge}
              </Badge>
            )}
          </div>

          {/* 2. Summary */}
          {!isEmpty(analysis.summary) && (
            <SectionCard title="Summary">
              <p className="whitespace-pre-wrap text-sm">{analysis.summary}</p>
            </SectionCard>
          )}

          {/* 3. Totals */}
          {!isEmpty(analysis.totals) && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Object.entries(analysis.totals!).map(([k, v]) => (
                <KPICardSmall key={k} label={k} value={v} />
              ))}
            </div>
          )}

          {/* 4. Status breakdown */}
          {!isEmpty(analysis.status_breakdown) && (
            <SectionCard title="Status breakdown">
              <div className="flex flex-wrap gap-2">
                {Object.entries(analysis.status_breakdown!).map(([k, v]) => (
                  <Badge key={k} variant="secondary" className="font-normal">
                    {k}: {fmtNum(v)}
                  </Badge>
                ))}
              </div>
            </SectionCard>
          )}

          {/* 5. Flags */}
          {Array.isArray(analysis.flags) && analysis.flags.length > 0 && (
            <SectionCard title={`Flags (${analysis.flags.length})`}>
              <ul className="space-y-2 text-sm">
                {analysis.flags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {f.severity && (
                      <Badge variant="outline" className="mt-0.5 text-[10px]">
                        {f.severity}
                      </Badge>
                    )}
                    <span>{f.message || f.title || JSON.stringify(f)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          {/* 6. Sheets dashboard */}
          {sheets.length > 0 && (
            <div className="space-y-4">
              {sheets.length > 1 ? (
                <Tabs
                  value={currentSheet?.label}
                  onValueChange={(v) => setSelectedSheet(v)}
                >
                  <TabsList className="flex flex-wrap">
                    {sheets.map((s) => (
                      <TabsTrigger key={s.label} value={s.label}>
                        {s.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {sheets.map((s) => (
                    <TabsContent key={s.label} value={s.label} className="mt-4">
                      <SheetView sheet={s} />
                    </TabsContent>
                  ))}
                </Tabs>
              ) : (
                currentSheet && <SheetView sheet={currentSheet} />
              )}
            </div>
          )}

          {/* 7. Extended analysis */}
          {analysis.risk_score !== undefined && !isEmpty(analysis.risk_score) && (
            <SectionCard title="Risk score">
              <RiskScore value={analysis.risk_score} />
            </SectionCard>
          )}
          {Array.isArray(analysis.top_delay_reasons) && analysis.top_delay_reasons.length > 0 && (
            <SectionCard title="Top delay reasons">
              <RankedTable data={analysis.top_delay_reasons} />
            </SectionCard>
          )}
          {Array.isArray(analysis.person_ranking) && analysis.person_ranking.length > 0 && (
            <SectionCard title="Person ranking">
              <RankedTable data={analysis.person_ranking} />
            </SectionCard>
          )}
          {Array.isArray(analysis.department_ranking) && analysis.department_ranking.length > 0 && (
            <SectionCard title="Department ranking">
              <RankedTable data={analysis.department_ranking} />
            </SectionCard>
          )}
          {Array.isArray(analysis.tat_performance) && analysis.tat_performance.length > 0 && (
            <SectionCard title="TAT performance">
              <RankedTable data={analysis.tat_performance} />
            </SectionCard>
          )}
          {!isEmpty(analysis.correlation_matrix) && (
            <SectionCard title="Correlation matrix">
              <CorrelationMatrix data={analysis.correlation_matrix} />
            </SectionCard>
          )}
          {!isEmpty(analysis.timeline_correlation) && (
            <SectionCard title="Timeline correlation">
              <TimelineCorrelation data={analysis.timeline_correlation} />
            </SectionCard>
          )}
          {!isEmpty(analysis.dependency_chains) && (
            <SectionCard title="Dependency chains">
              <DependencyChains data={analysis.dependency_chains} />
            </SectionCard>
          )}
          {!isEmpty(analysis.variance) && (
            <SectionCard title="Variance">
              <GenericValue value={analysis.variance} />
            </SectionCard>
          )}

          {/* 8. Modules */}
          {!isEmpty(modules.digest) && (
            <SectionCard title="Digest">
              <Digest data={modules.digest} />
            </SectionCard>
          )}
          {Array.isArray(modules.recommendations) && modules.recommendations.length > 0 && (
            <SectionCard title="Recommendations">
              <Recommendations items={modules.recommendations} />
            </SectionCard>
          )}
          {!isEmpty(modules.data_quality) && (
            <SectionCard title="Data quality">
              <DataQuality dq={modules.data_quality!} />
            </SectionCard>
          )}
          {!isEmpty(modules.pivot) && (
            <SectionCard title="Pivot">
              <Pivot data={modules.pivot} />
            </SectionCard>
          )}
          {!isEmpty(modules.anomalies) && (
            <SectionCard title="Anomalies">
              <Anomalies data={modules.anomalies} />
            </SectionCard>
          )}
          {!isEmpty(modules.forecast) && (
            <SectionCard title="Forecast">
              <ForecastOrTrend data={modules.forecast} label="forecast" />
            </SectionCard>
          )}
          {!isEmpty(modules.trends) && (
            <SectionCard title="Trends">
              <ForecastOrTrend data={modules.trends} label="trends" />
            </SectionCard>
          )}
          {!isEmpty(modules.whatif) && (
            <SectionCard title="What-if">
              <WhatIf data={modules.whatif} />
            </SectionCard>
          )}

          {/* 9. Copilot */}
          {analysis.copilot_enabled && currentSheet && (
            <CopilotCard base={base} sheetLabel={currentSheet.label} />
          )}

          {/* Catch-all */}
          {hasExtras && (
            <Card>
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <button className="flex w-full items-center justify-between p-6 text-left">
                    <span className="text-sm font-semibold">Additional data</span>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="space-y-4 pt-0">
                    {extraTopKeys.map((k) => (
                      <div key={k} className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          {k}
                        </div>
                        <GenericValue value={(data as any)[k]} />
                      </div>
                    ))}
                    {extraAnalysisKeys.map((k) => (
                      <div key={`a-${k}`} className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          analysis.{k}
                        </div>
                        <GenericValue value={(analysis as any)[k]} />
                      </div>
                    ))}
                    {extraModuleKeys.map((k) => (
                      <div key={`m-${k}`} className="space-y-2">
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          modules.{k}
                        </div>
                        <GenericValue value={(modules as any)[k]} />
                      </div>
                    ))}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
