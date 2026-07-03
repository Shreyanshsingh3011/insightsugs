import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Loader2,
  Sparkles,
  FileText,
  RefreshCw,
  Wand2,
  AlertTriangle,
  Info,
  AlertCircle,
  Trash2,
} from "lucide-react";
import { listSheets, askCopilot, generateAutoInsights, generateChart } from "@/lib/sheets.functions";
import { listDocuments } from "@/lib/documents.functions";
import { SHEET_TYPE_LABELS, type SheetType } from "@/lib/sheets-schemas";
import { ChatGroundingHint } from "@/components/ChatGroundingHint";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import { BarChart3 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/copilot")({
  component: CopilotPage,
});

type Source = { id: string; name: string; type: string; rowsUsed: number; truncated: boolean };
type ChartSpec = {
  sheetId: string;
  sheet: string;
  chartType: "bar" | "line" | "pie";
  title: string;
  xKey: string;
  yKey: string;
  data: { name: string; value: number }[];
};
type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  suggestions: string[];
  charts?: ChartSpec[];
  citationsMissing?: boolean;
  retriedForCitations?: boolean;
};

// A response is grounded when it contains at least one inline [...] marker AND
// a "Sources:" section — matches GROUNDING_RULES in src/lib/gemini-client.ts.
// Ignore the "I don't have that in the current dashboard data." fallback.
function validateCitations(answer: string): boolean {
  const t = answer.trim();
  if (!t) return false;
  if (/^i don'?t have that in the current dashboard data/i.test(t)) return true;
  const hasInline = /\[[^\]\n]{2,}\]/.test(t);
  const hasSources = /(^|\n)\s*sources\s*:/i.test(t);
  return hasInline && hasSources;
}

type Insight = { title: string; detail: string; severity: "info" | "warning" | "critical" };

const CHART_COLORS = ["hsl(var(--primary))", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

function CopilotPage() {
  const fetchList = useServerFn(listSheets);
  const fetchDocs = useServerFn(listDocuments);
  const ask = useServerFn(askCopilot);
  const autoInsights = useServerFn(generateAutoInsights);
  const chartFn = useServerFn(generateChart);

  const sheets = useQuery({ queryKey: ["sheets-list"], queryFn: () => fetchList() });
  const documents = useQuery({
    queryKey: ["copilot-documents"],
    queryFn: () => fetchDocs({ data: {} }),
  });

  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Turn[]>([]);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [insightsSheet, setInsightsSheet] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const sendAsk = (q: string) => {
    askMut.mutate({
      question: q,
      history: history.flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: t.answer },
      ]),
    });
  };

  const askMut = useMutation({
    mutationFn: (vars: {
      question: string;
      history: { role: "user" | "assistant"; content: string }[];
      retryForCitations?: boolean;
      originalQuestion?: string;
    }) => {
      const q = vars.retryForCitations
        ? `REMINDER: your previous answer was rejected because it lacked citations. Repeat your answer for the question below, but every factual sentence MUST have an inline citation marker like [flags[F-0003]] or [sheet:<name> row <n>], and the answer MUST end with a "Sources:" list. If a fact can't be cited from the provided data, say "I don't have that in the current dashboard data." instead.\n\nQuestion: ${vars.originalQuestion ?? vars.question}`
        : vars.question;
      return ask({
        data: {
          question: q,
          sheetIds: Array.from(selected),
          documentIds: Array.from(selectedDocs),
          history: vars.history,
        },
      });
    },
    onMutate: (vars) => {
      if (!vars.retryForCitations) setQuestion("");
    },
    onSuccess: (res, vars) => {
      const displayedQuestion = vars.originalQuestion ?? vars.question;
      const ok = validateCitations(res.answer);
      if (!ok && !vars.retryForCitations) {
        // First failure — auto-retry once with a stronger cite instruction.
        toast.info("Answer missing citations — retrying…");
        askMut.mutate({
          question: displayedQuestion,
          history: vars.history,
          retryForCitations: true,
          originalQuestion: displayedQuestion,
        });
        return;
      }
      setHistory((h) => [
        ...h,
        {
          question: displayedQuestion,
          answer: res.answer,
          sources: res.sources,
          suggestions: (res as any).suggestions ?? [],
          citationsMissing: !ok,
          retriedForCitations: vars.retryForCitations,
        },
      ]);
      if (!ok && vars.retryForCitations) {
        toast.warning("Copilot still didn't cite sources — flagged inline.");
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "AI request failed"),
  });

  const insightsMut = useMutation({
    mutationFn: (sheetId: string) => autoInsights({ data: { sheetId } }),
    onSuccess: (res) => {
      setInsights(res.insights);
      setInsightsSheet(res.sheetName);
      if (res.insights.length === 0) toast.info("No notable findings detected for this sheet.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't generate insights"),
  });

  const chartMut = useMutation({
    mutationFn: (vars: { turnIndex: number; question: string }) =>
      chartFn({ data: { question: vars.question, sheetIds: Array.from(selected) } }),
    onSuccess: (res, vars) => {
      if (!res.charts.length) {
        toast.info("Couldn't build a chart from this question.");
        return;
      }
      setHistory((h) =>
        h.map((t, i) => (i === vars.turnIndex ? { ...t, charts: res.charts } : t)),
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Chart generation failed"),
  });

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Reset insights when sheet scope changes
    setInsights(null);
    setInsightsSheet(null);
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const canSend =
    question.trim().length > 0 &&
    (selected.size > 0 || selectedDocs.size > 0) &&
    !askMut.isPending;

  const regenerate = () => {
    if (history.length === 0 || askMut.isPending) return;
    const last = history[history.length - 1];
    const priorHistory = history.slice(0, -1);
    setHistory(priorHistory);
    askMut.mutate({
      question: last.question,
      history: priorHistory.flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: t.answer },
      ]),
    });
  };

  // Auto-scroll on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [history.length, askMut.isPending]);

  // Keep textarea focused
  useEffect(() => {
    if (!askMut.isPending) textareaRef.current?.focus();
  }, [askMut.isPending, history.length]);

  const singleSheetId = selected.size === 1 ? Array.from(selected)[0] : null;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:grid-cols-[260px_1fr] md:p-6">
      {/* Sidebar: sheet + document picker */}
      <aside className="space-y-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">Sheets in context</h2>
            <span className="text-xs text-muted-foreground">{selected.size} selected</span>
          </div>
          {sheets.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (sheets.data?.sheets ?? []).length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Register sheets first on the My Sheets page.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {sheets.data!.sheets.map((s: any) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/50">
                    <Checkbox
                      checked={selected.has(s.id)}
                      onCheckedChange={() => toggle(s.id)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{s.display_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {SHEET_TYPE_LABELS[s.sheet_type as SheetType]} · {s.row_count} rows
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-sm font-medium">
              <FileText className="h-3.5 w-3.5" /> Documents
            </h2>
            <span className="text-xs text-muted-foreground">{selectedDocs.size} selected</span>
          </div>
          {documents.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (documents.data?.documents ?? []).length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Upload documents on the Documents page.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {documents.data!.documents.map((d: any) => (
                <li key={d.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/50">
                    <Checkbox
                      checked={selectedDocs.has(d.id)}
                      onCheckedChange={() => toggleDoc(d.id)}
                      disabled={d.status !== "ready"}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm">{d.name}</div>
                      <div className="text-xs text-muted-foreground capitalize">
                        {d.status}
                        {d.page_count ? ` · ${d.page_count} pages` : ""}
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ChatGroundingHint />
      </aside>



      {/* Conversation */}
      <section className="flex min-h-[60vh] flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              <Sparkles className="h-5 w-5 text-primary" /> Copilot
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Conversational AI over your sheets and documents. Follow-ups remember context.
            </p>
          </div>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setHistory([]);
                toast.success("Conversation cleared");
              }}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear chat
            </Button>
          )}
        </div>

        {/* Auto-Insights digest (when exactly one sheet selected & no chat yet) */}
        {singleSheetId && history.length === 0 && (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="h-4 w-4 text-primary" /> Auto-Insights
                {insightsSheet && (
                  <span className="text-xs font-normal text-muted-foreground">· {insightsSheet}</span>
                )}
              </h3>
              <Button
                size="sm"
                variant={insights ? "ghost" : "default"}
                onClick={() => insightsMut.mutate(singleSheetId)}
                disabled={insightsMut.isPending}
              >
                {insightsMut.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {insights ? "Regenerate" : "Generate"}
              </Button>
            </div>
            {!insights && !insightsMut.isPending && (
              <p className="text-xs text-muted-foreground">
                AI scans the full sheet and surfaces anomalies, outliers and noteworthy patterns —
                no question needed.
              </p>
            )}
            {insights && insights.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {insights.map((ins, i) => {
                  const Icon =
                    ins.severity === "critical"
                      ? AlertCircle
                      : ins.severity === "warning"
                        ? AlertTriangle
                        : Info;
                  const tone =
                    ins.severity === "critical"
                      ? "border-destructive/40 bg-destructive/5"
                      : ins.severity === "warning"
                        ? "border-amber-400/40 bg-amber-50/40 dark:bg-amber-950/20"
                        : "border-border bg-muted/30";
                  return (
                    <div key={i} className={`rounded-md border p-3 text-sm ${tone}`}>
                      <div className="mb-1 flex items-start gap-1.5 font-medium">
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{ins.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{ins.detail}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto">
          {history.length === 0 && !askMut.isPending && !singleSheetId ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Select one or more sheets on the left, then ask a question below. With multiple
              sheets, Copilot returns a combined deduplicated answer plus a per-sheet breakdown.
              Use <span className="font-medium">Chart this</span> on any answer to visualise it.
            </Card>
          ) : (
            history.map((t, i) => {
              const isLast = i === history.length - 1;
              return (
                <div key={i} className="space-y-2">
                  <Card className="bg-muted/40 p-3 text-sm">
                    <div className="mb-1 text-xs font-medium text-muted-foreground">You</div>
                    {t.question}
                  </Card>
                  <Card className="p-3 text-sm">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="text-xs font-medium text-muted-foreground">Copilot</div>
                      {isLast && !askMut.isPending && (
                        <div className="flex items-center gap-1">
                          {selected.size > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              disabled={chartMut.isPending}
                              onClick={() =>
                                chartMut.mutate({ turnIndex: i, question: t.question })
                              }
                            >
                              {chartMut.isPending && chartMut.variables?.turnIndex === i ? (
                                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              ) : (
                                <BarChart3 className="mr-1 h-3 w-3" />
                              )}
                              {t.charts?.length ? "Regenerate chart" : "Chart this"}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={regenerate}
                          >
                            <RefreshCw className="mr-1 h-3 w-3" /> Regenerate
                          </Button>
                        </div>
                      )}
                    </div>
                    {t.citationsMissing && (
                      <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                        <div className="flex-1">
                          <div className="font-medium text-destructive">
                            Citations missing — treat this answer as ungrounded.
                          </div>
                          <div className="mt-0.5 text-muted-foreground">
                            Copilot didn't include inline <code className="rounded bg-background px-1">[…]</code>
                            {" "}markers or a <span className="font-medium">Sources:</span> list.
                            {t.retriedForCitations ? " Automatic retry also failed." : ""}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={askMut.isPending}
                          onClick={() =>
                            askMut.mutate({
                              question: t.question,
                              history: history.slice(0, i).flatMap((x) => [
                                { role: "user" as const, content: x.question },
                                { role: "assistant" as const, content: x.answer },
                              ]),
                              retryForCitations: true,
                              originalQuestion: t.question,
                            })
                          }
                        >
                          <RefreshCw className="mr-1 h-3 w-3" /> Re-ask with citations
                        </Button>
                      </div>
                    )}
                    <div className="prose prose-sm dark:prose-invert max-w-none prose-table:my-2 prose-p:my-1.5 prose-headings:my-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.answer}</ReactMarkdown>
                    </div>

                    {t.charts && t.charts.length > 0 && (
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        {t.charts.map((c, ci) => (
                          <div key={ci} className="rounded-md border bg-muted/20 p-2">
                            <div className="mb-1 text-xs font-medium">
                              {c.title}
                              <span className="ml-1 text-muted-foreground">· {c.sheet}</span>
                            </div>
                            <div className="h-56">
                              <ResponsiveContainer width="100%" height="100%">
                                {c.chartType === "pie" ? (
                                  <PieChart>
                                    <Pie
                                      data={c.data}
                                      dataKey="value"
                                      nameKey="name"
                                      outerRadius={70}
                                      label
                                    >
                                      {c.data.map((_, idx) => (
                                        <Cell
                                          key={idx}
                                          fill={CHART_COLORS[idx % CHART_COLORS.length]}
                                        />
                                      ))}
                                    </Pie>
                                    <Tooltip />
                                    <Legend />
                                  </PieChart>
                                ) : c.chartType === "line" ? (
                                  <LineChart data={c.data}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis dataKey="name" fontSize={10} />
                                    <YAxis fontSize={10} />
                                    <Tooltip />
                                    <Line
                                      type="monotone"
                                      dataKey="value"
                                      stroke={CHART_COLORS[0]}
                                      strokeWidth={2}
                                    />
                                  </LineChart>
                                ) : (
                                  <BarChart data={c.data}>
                                    <CartesianGrid strokeDasharray="3 3" />
                                    <XAxis dataKey="name" fontSize={10} />
                                    <YAxis fontSize={10} />
                                    <Tooltip />
                                    <Bar dataKey="value" fill={CHART_COLORS[0]} />
                                  </BarChart>
                                )}
                              </ResponsiveContainer>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {t.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {t.sources.map((s) => (
                          <Badge key={s.id} variant="outline" className="text-xs">
                            {s.name} ({s.rowsUsed}
                            {s.truncated ? "+" : ""} rows)
                          </Badge>
                        ))}
                      </div>
                    )}
                    {isLast && t.suggestions.length > 0 && !askMut.isPending && (
                      <div className="mt-3 border-t pt-3">
                        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                          Suggested follow-ups
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {t.suggestions.map((sug, j) => (
                            <button
                              key={j}
                              onClick={() => sendAsk(sug)}
                              className="rounded-full border bg-background px-2.5 py-1 text-xs hover:border-primary hover:bg-primary/5"
                            >
                              {sug}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                </div>
              );
            })
          )}
          {askMut.isPending && (
            <Card className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Thinking…
            </Card>
          )}
        </div>

        <Card className="p-3">
          <Textarea
            ref={textareaRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask anything. Follow-ups understand context (e.g. 'now break that down by region')."
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
                e.preventDefault();
                sendAsk(question.trim());
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
            <Button onClick={() => sendAsk(question.trim())} disabled={!canSend}>
              {askMut.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Ask
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}
