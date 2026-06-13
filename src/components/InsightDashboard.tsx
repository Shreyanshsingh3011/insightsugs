import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Send, Sparkles } from "lucide-react";

type Column = { name: string; type: "number" | "date" | "category" | "text" };
type KPI = { label: string; value: number | string };
type Chart = { title: string; data: { name: string; value: number }[] };
type Sheet = {
  label: string;
  name: string;
  row_count: number;
  columns: Column[];
  kpis: KPI[];
  charts: Chart[];
  rows: Record<string, unknown>[];
  truncated: boolean;
};
type DashboardData = { project: string; sheets: Sheet[] };
type DisabledData = { enabled: false; message: string };
type ChatMsg = { role: "user" | "assistant"; text: string };

const STARTERS = [
  "Summarize this sheet in 3 points",
  "Which category has the highest total?",
  "Any data-quality issues?",
];

function fmt(v: unknown) {
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString();
  if (v === null || v === undefined) return "";
  return String(v);
}

export default function InsightDashboard({ apiBase, token }: { apiBase: string; token: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    fetch(`${apiBase}/api/public/${token}/dashboard`, { credentials: "omit" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancel) return;
        if (j && j.enabled === false) setDisabled((j as DisabledData).message || "Insights are disabled.");
        else setData(j as DashboardData);
      })
      .catch((e) => !cancel && setError(e?.message || "Failed to load"))
      .finally(() => !cancel && setLoading(false));
    return () => {
      cancel = true;
    };
  }, [apiBase, token]);

  const selected = data?.sheets?.[selectedIdx];

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (disabled) return <Card><CardContent className="p-6 text-muted-foreground">{disabled}</CardContent></Card>;
  if (error) return <Card><CardContent className="p-6 text-destructive">Failed to load insights: {error}</CardContent></Card>;
  if (!data || !data.sheets?.length) return <Card><CardContent className="p-6 text-muted-foreground">No sheets available.</CardContent></Card>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{data.project || "Insights"}</h1>
        <p className="text-sm text-muted-foreground">External analytics overview</p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {data.sheets.map((s, i) => (
          <Button
            key={s.label + i}
            size="sm"
            variant={i === selectedIdx ? "default" : "outline"}
            onClick={() => setSelectedIdx(i)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {selected && (
        <>
          {selected.kpis?.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {selected.kpis.map((k, i) => (
                <Card key={i}>
                  <CardContent className="p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">{k.label}</div>
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{fmt(k.value)}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {selected.charts?.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {selected.charts.map((c, i) => (
                <Card key={i}>
                  <CardHeader><CardTitle className="text-sm">{c.title}</CardTitle></CardHeader>
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
                {selected.label} <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {selected.row_count.toLocaleString()} rows{selected.truncated ? " (truncated)" : ""}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-96 w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {selected.columns.map((c) => (
                        <TableHead key={c.name}>
                          <div className="flex items-center gap-1.5">
                            <span>{c.name}</span>
                            <Badge variant="secondary" className="text-[10px] font-normal">{c.type}</Badge>
                          </div>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selected.rows.slice(0, 100).map((row, ri) => (
                      <TableRow key={ri}>
                        {selected.columns.map((c) => (
                          <TableCell key={c.name} className="whitespace-nowrap">{fmt(row[c.name])}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>

          <CopilotCard apiBase={apiBase} token={token} sheetLabel={selected.label} />
        </>
      )}
    </div>
  );
}

function CopilotCard({ apiBase, token, sheetLabel }: { apiBase: string; token: string; sheetLabel: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setSessionId(null);
    setErr(null);
  }, [sheetLabel]);

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
      const url = `${apiBase}/api/public/${token}/copilot?sheet=${encodeURIComponent(sheetLabel)}`;
      const r = await fetch(url, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, session_id: sessionId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { answer: string; session_id: string };
      setSessionId(j.session_id || null);
      setMessages((m) => [...m, { role: "assistant", text: j.answer || "(no answer)" }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Request failed";
      setErr(msg);
    } finally {
      setThinking(false);
    }
  }

  const showStarters = useMemo(() => messages.length === 0, [messages.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          Copilot — {sheetLabel}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div ref={scrollRef} className="h-80 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 space-y-3">
          {messages.length === 0 && !thinking && (
            <p className="text-sm text-muted-foreground">Ask anything about this sheet.</p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background border border-border"
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

        {showStarters && (
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
