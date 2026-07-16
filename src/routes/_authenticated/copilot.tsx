import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
  ShieldCheck,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { listSheets, askCopilot, generateAutoInsights, generateCombinedAutoInsights, generateDocumentAutoInsights, generateChart } from "@/lib/sheets.functions";
import { listDocuments } from "@/lib/documents.functions";
import { useLiveInvalidate } from "@/hooks/useLiveInvalidate";
import { LiveStatusBadge } from "@/components/LiveStatusBadge";
import { AIStatusBadge } from "@/components/AIStatusBadge";


import { SHEET_TYPE_LABELS, type SheetType } from "@/lib/sheets-schemas";
import { ChatGroundingHint } from "@/components/ChatGroundingHint";
import { ToolCallTrace } from "@/components/copilot/ToolCallTrace";
import { renderWithCitations } from "@/components/copilot/CitationLink";
import { PrimarySourceLink, stripCitations } from "@/components/copilot/PrimarySourceLink";
import { useSession } from "@/hooks/useSession";
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

type Source = { id: string; name: string; type: string; rowsUsed: number; rowsTotal?: number; truncated: boolean };
type CachedSourceList<T> = { rows: T[]; cachedAt: string };
type ChartSpec = {
  sheetId: string;
  sheet: string;
  chartType: "bar" | "line" | "pie";
  title: string;
  xKey: string;
  yKey: string;
  data: { name: string; value: number }[];
};

const COPILOT_SHEETS_CACHE_KEY = "copilot:lastGoodSheets";
const COPILOT_DOCUMENTS_CACHE_KEY = "copilot:lastGoodDocuments";

function scopedCopilotKey(base: string, userId: string | null) {
  return `${base}:${userId ?? "signed-out"}`;
}

function readSessionJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readCachedSourceList<T>(key: string): CachedSourceList<T> {
  if (typeof window === "undefined") return { rows: [], cachedAt: "" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "null") as CachedSourceList<T> | null;
    return Array.isArray(parsed?.rows) ? parsed : { rows: [], cachedAt: "" };
  } catch {
    return { rows: [], cachedAt: "" };
  }
}

function writeCachedSourceList<T>(key: string, rows: T[]) {
  if (typeof window === "undefined" || rows.length === 0) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ rows, cachedAt: new Date().toISOString() }));
  } catch { /* ignore quota/storage errors */ }
}
type Turn = {
  question: string;
  answer: string;
  sources: Source[];
  suggestions: string[];
  charts?: ChartSpec[];
  citationsMissing?: boolean;
  citationValidation?: CitationValidation;
  retriedForCitations?: boolean;
  toolTrace?: import("@/components/copilot/ToolCallTrace").ToolCall[];
  retrievalDiagnostics?: RetrievalDiagnostic[];
  citationOk?: boolean;
  unmatchedTerms?: string[];
};


type RetrievalDiagnostic = {
  sourceId: string;
  sourceName: string;
  sourceType: "sheet" | "document";
  matcherPath: string;
  rowsScanned: number;
  rowsMatched: number;
  columnsSearched?: string[];
  reason?: string;
  missingColumns?: string[];
  derivedFields?: string[];
};

function ThinkingElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <span>Thinking… <span className="tabular-nums opacity-70">({secs}s)</span></span>;
}


// Detailed citation validator. Returns { ok, issues[] } so the UI can explain
// exactly what is missing when we reject an answer. Matches GROUNDING_RULES in
// src/lib/gemini-client.ts:
//   * Every non-fallback answer must contain at least one inline [..] marker.
//   * Inline markers must use a recognised shape: [sheet:<name> row <n>],
//     [flags[<id>]], or [doc:<name> p.<n>].
//   * A "Sources:" section must exist and list at least one bullet.
//   * Every distinct inline marker must appear (verbatim or by ref) in Sources.
export type CitationIssue =
  | "empty"
  | "no_inline_citations"
  | "malformed_citations"
  | "no_sources_section"
  | "empty_sources_section"
  | "uncited_in_sources";

export type CitationValidation = {
  ok: boolean;
  issues: CitationIssue[];
  inlineCount: number;
  malformed: string[];
  uncited: string[];
  isFallback: boolean;
};

const INLINE_RE = /\[([^\]\n]{2,}?)\]/g;

// Walk react-markdown children and replace any string containing inline [..]
// citation markers with clickable citation links.
function decorateChildren(children: React.ReactNode, sources: Source[]): React.ReactNode {
  const walk = (node: React.ReactNode, key: string): React.ReactNode => {
    if (typeof node === "string") {
      if (!/\[[^\]\n]{2,}?\]/.test(node)) return node;
      return <>{renderWithCitations(node, sources)}</>;
    }
    if (Array.isArray(node)) return node.map((c, i) => walk(c, `${key}-${i}`));
    return node;
  };
  return walk(children, "d");
}
const KNOWN_SHAPES = [
  /^sheet:\s*.+?(?:\s+row\s+(?:\d+|\d+\s*-\s*\d+|\d+(?:\s*,\s*\d+)+)(?:\s+col\s+.+)?)?$/i,
  /^flags?\[.+\]$/i,
  /^doc:\s*.+?(?:\s+p\.?\s*\d+)?$/i,
];

function extractInlineMarkers(answer: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(answer)) !== null) {
    // Skip markdown link labels [text](url).
    if (answer[m.index + m[0].length] === "(") continue;
    const raw = m[1].trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export function validateCitationsDetailed(answer: string): CitationValidation {
  const t = (answer ?? "").trim();
  const base: CitationValidation = {
    ok: false, issues: [], inlineCount: 0, malformed: [], uncited: [], isFallback: false,
  };
  if (!t) return { ...base, issues: ["empty"] };
  if (/^i don'?t have that in the current dashboard data/i.test(t)) {
    return { ...base, ok: true, isFallback: true };
  }
  const issues: CitationIssue[] = [];
  const markers = extractInlineMarkers(t);
  if (markers.length === 0) issues.push("no_inline_citations");
  const malformed = markers.filter((raw) => !KNOWN_SHAPES.some((re) => re.test(raw)));
  if (malformed.length > 0 && markers.length > 0) issues.push("malformed_citations");

  const sourcesMatch = t.match(/(^|\n)\s*sources\s*:\s*([\s\S]*)$/i);
  let uncited: string[] = [];
  if (!sourcesMatch) {
    issues.push("no_sources_section");
  } else {
    const body = sourcesMatch[2].trim();
    if (!body || !/\S/.test(body.replace(/[-*•\d.\s]/g, ""))) {
      issues.push("empty_sources_section");
    } else {
      const bodyLc = body.toLowerCase();
      uncited = markers.filter((raw) => {
        const lc = raw.toLowerCase();
        if (bodyLc.includes(lc)) return false;
        // Also accept a match on the ref part (sheet/doc name, flag id).
        const refPart = lc.replace(/^(sheet:|doc:|flags?\[)/, "").replace(/\]$/, "").split(/\s+row\s+|\s+p\.?\s*/)[0]?.trim();
        return !(refPart && bodyLc.includes(refPart));
      });
      if (uncited.length > 0) issues.push("uncited_in_sources");
    }
  }

  return { ...base, ok: issues.length === 0, issues, inlineCount: markers.length, malformed, uncited };
}

// Boolean wrapper kept for the mutation retry check.
function validateCitations(answer: string): boolean {
  return validateCitationsDetailed(answer).ok;
}


/** Parse inline [..] citation markers from an answer and classify each. */
type ParsedCitation = { raw: string; kind: string; ref: string; matchedSource?: Source };
function parseCitations(answer: string, sources: Source[]): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  const seen = new Set<string>();
  const re = /\[([^\]\n]{2,}?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const raw = m[1].trim();
    if (seen.has(raw)) continue;
    seen.add(raw);
    // Skip markdown link labels [text](url) — the "]" is immediately followed by "(".
    if (answer[m.index + m[0].length] === "(") continue;
    let kind = "reference";
    let ref = raw;
    let matched: Source | undefined;
    const sheetMatch = raw.match(/^sheet:\s*(.+?)(?:\s+row\s+([\d\s,-]+)(?:\s+col\s+(.+))?)?$/i);
    const flagMatch = raw.match(/^flags?\[(.+)\]$/i);
    const docMatch = raw.match(/^doc:\s*(.+?)(?:\s+p\.?\s*(\d+))?$/i);
    if (sheetMatch) {
      kind = "sheet";
      ref = sheetMatch[2]
        ? `${sheetMatch[1]} · row ${sheetMatch[2]}${sheetMatch[3] ? ` · col ${sheetMatch[3]}` : ""}`
        : sheetMatch[1];
      const needle = sheetMatch[1].toLowerCase().replace(/\s+/g, " ").trim();
      matched = sources.find(
        (s) =>
          s.type !== "document" &&
          (s.name.toLowerCase().replace(/\s+/g, " ").trim() === needle ||
            s.name.toLowerCase().replace(/\s+/g, " ").trim().includes(needle) ||
            s.id.toLowerCase() === needle),
      );
    } else if (flagMatch) {
      kind = "flag";
      ref = flagMatch[1];
    } else if (docMatch) {
      kind = "document";
      ref = docMatch[2] ? `${docMatch[1]} · p. ${docMatch[2]}` : docMatch[1];
      const needle = docMatch[1].toLowerCase();
      matched = sources.find((s) => s.type === "document" && s.name.toLowerCase().includes(needle));
    }
    out.push({ raw, kind, ref, matchedSource: matched });
  }
  return out;
}

function GroundingInspector({ answer, sources }: { answer: string; sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const citations = useMemo(() => parseCitations(answer, sources), [answer, sources]);
  const orphanSources = sources.filter((s) => !citations.some((c) => c.matchedSource?.id === s.id));
  const missingMatches = citations.filter((c) => (c.kind === "sheet" || c.kind === "document") && !c.matchedSource);

  return (
    <div className="mt-3 rounded-md border bg-muted/20 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left hover:bg-muted/40"
      >
        <span className="flex items-center gap-1.5 font-medium">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <ShieldCheck className="h-3 w-3 text-primary" />
          Grounding check
          <span className="text-muted-foreground">
            · {citations.length} citation{citations.length === 1 ? "" : "s"}
            {missingMatches.length > 0 && ` · ${missingMatches.length} unmatched`}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t px-2.5 py-2 space-y-2">
          {citations.length === 0 ? (
            <p className="text-destructive">No inline [..] citations found in this answer.</p>
          ) : (
            <ul className="space-y-1">
              {citations.map((c, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5">
                  <code className="rounded bg-background px-1 font-mono text-[10px]">[{c.raw}]</code>
                  <span className="text-muted-foreground">→</span>
                  <Badge variant="outline" className="text-[10px] capitalize">{c.kind}</Badge>
                  <span>{c.ref}</span>
                  {c.matchedSource ? (
                    <span className="text-emerald-600 dark:text-emerald-400">✓ {c.matchedSource.name}</span>
                  ) : c.kind === "sheet" || c.kind === "document" ? (
                    <span className="text-destructive">✗ no matching source</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {orphanSources.length > 0 && (
            <div className="border-t pt-2">
              <div className="mb-1 font-medium text-muted-foreground">
                Sources loaded but never cited:
              </div>
              <div className="flex flex-wrap gap-1">
                {orphanSources.map((s) => (
                  <Badge key={s.id} variant="outline" className="text-[10px]">
                    {s.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GroundingDiagnostics({ diagnostics }: { diagnostics?: RetrievalDiagnostic[] }) {
  const [open, setOpen] = useState(true);
  if (!diagnostics || diagnostics.length === 0) return null;

  const totalMatched = diagnostics.reduce((sum, d) => sum + (d.rowsMatched ?? 0), 0);

  return (
    <div className="mb-2 rounded-md border border-border/60 bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <ShieldCheck className="h-3.5 w-3.5" />
        <span className="font-medium">Retrieval diagnostics</span>
        <span className="text-[0.7rem] opacity-70">{totalMatched} row/chunk match{totalMatched === 1 ? "" : "es"}</span>
      </button>
      {open && (
        <div className="divide-y divide-border/60 px-2 pb-2">
          {diagnostics.map((d, index) => (
            <div key={`${d.sourceId}-${d.matcherPath}-${index}`} className="py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] capitalize">{d.sourceType}</Badge>
                <span className="font-medium">{d.sourceName}</span>
                <code className="rounded bg-background px-1 font-mono text-[10px]">{d.matcherPath}</code>
              </div>
              <div className="mt-1 text-muted-foreground">
                scanned {d.rowsScanned.toLocaleString()} · matched {d.rowsMatched.toLocaleString()}
                {d.reason && <> · {d.reason}</>}
                {d.columnsSearched && d.columnsSearched.length > 0 && (
                  <> · columns: {d.columnsSearched.slice(0, 8).join(", ")}{d.columnsSearched.length > 8 ? "…" : ""}</>
                )}
              </div>
              {(d.missingColumns?.length || d.derivedFields?.length) ? (
                <div className="mt-1 space-y-1 text-[11px]">
                  {d.missingColumns && d.missingColumns.length > 0 && (
                    <div className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-amber-900 dark:text-amber-200">
                      <strong>Missing columns:</strong> {d.missingColumns.join(", ")} — answer could not be fully computed from current data.
                    </div>
                  )}
                  {d.derivedFields && d.derivedFields.length > 0 && (
                    <div className="rounded border border-border/60 bg-background/60 px-2 py-1 text-muted-foreground">
                      <strong>Derived fields used:</strong> {d.derivedFields.join(" · ")}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


type Insight = { title: string; detail: string; severity: "info" | "warning" | "critical" };

const CHART_COLORS = ["hsl(var(--primary))", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];

function CopilotPage() {
  const { userId } = useSession();
  const fetchList = useServerFn(listSheets);
  const fetchDocs = useServerFn(listDocuments);
  const ask = useServerFn(askCopilot);
  const autoInsights = useServerFn(generateAutoInsights);
  const autoCombinedInsights = useServerFn(generateCombinedAutoInsights);
  const autoDocInsights = useServerFn(generateDocumentAutoInsights);
  const chartFn = useServerFn(generateChart);



  const sheets = useQuery({ queryKey: ["sheets-list"], queryFn: () => fetchList() });
  const documents = useQuery({
    queryKey: ["copilot-documents"],
    queryFn: () => fetchDocs({ data: {} }),
  });
  const cachedSheets = useMemo(() => readCachedSourceList<any>(COPILOT_SHEETS_CACHE_KEY), []);
  const cachedDocuments = useMemo(() => readCachedSourceList<any>(COPILOT_DOCUMENTS_CACHE_KEY), []);
  const liveSheets = sheets.data?.sheets ?? [];
  const liveDocuments = documents.data?.documents ?? [];
  const visibleSheets = liveSheets.length > 0 ? liveSheets : cachedSheets.rows;
  const visibleDocuments = liveDocuments.length > 0 ? liveDocuments : cachedDocuments.rows;
  const usingCachedSheets = !sheets.isLoading && liveSheets.length === 0 && visibleSheets.length > 0;
  const usingCachedDocuments = !documents.isLoading && liveDocuments.length === 0 && visibleDocuments.length > 0;
  const live = useLiveInvalidate(
    ["sheet_rows", "sheet_registry"],
    [["sheets-list"], ["copilot-documents"]],
  );



  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => {
    return new Set(readSessionJson<string[]>(scopedCopilotKey("copilot:selected", userId), []));
  });
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(() => {
    return new Set(readSessionJson<string[]>(scopedCopilotKey("copilot:selectedDocs", userId), []));
  });
  const [history, setHistory] = useState<Turn[]>(() => {
    return readSessionJson<Turn[]>(scopedCopilotKey("copilot:history", userId), []);
  });
  useEffect(() => {
    setSelected(new Set(readSessionJson<string[]>(scopedCopilotKey("copilot:selected", userId), [])));
    setSelectedDocs(new Set(readSessionJson<string[]>(scopedCopilotKey("copilot:selectedDocs", userId), [])));
    setHistory(readSessionJson<Turn[]>(scopedCopilotKey("copilot:history", userId), []));
  }, [userId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.sessionStorage.setItem(scopedCopilotKey("copilot:history", userId), JSON.stringify(history.slice(-50))); } catch { /* ignore */ }
  }, [history, userId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.sessionStorage.setItem(scopedCopilotKey("copilot:selected", userId), JSON.stringify([...selected])); } catch { /* ignore */ }
  }, [selected, userId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.sessionStorage.setItem(scopedCopilotKey("copilot:selectedDocs", userId), JSON.stringify([...selectedDocs])); } catch { /* ignore */ }
  }, [selectedDocs, userId]);
  useEffect(() => {
    writeCachedSourceList(COPILOT_SHEETS_CACHE_KEY, liveSheets);
  }, [liveSheets]);
  useEffect(() => {
    writeCachedSourceList(COPILOT_DOCUMENTS_CACHE_KEY, liveDocuments);
  }, [liveDocuments]);

  useEffect(() => {
    if (visibleSheets.length === 0 && visibleDocuments.length === 0) return;
    const sheetIds = new Set(visibleSheets.map((s: any) => s.id));
    const documentIds = new Set(visibleDocuments.map((d: any) => d.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => sheetIds.has(id)));
      return next.size === current.size ? current : next;
    });
    setSelectedDocs((current) => {
      const next = new Set([...current].filter((id) => documentIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleSheets, visibleDocuments]);

  const [strictMatch, setStrictMatch] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("copilot:strictMatch") === "1";
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("copilot:strictMatch", strictMatch ? "1" : "0");
    }
  }, [strictMatch]);
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [insightsSheet, setInsightsSheet] = useState<string | null>(null);
  const [insightQuestions, setInsightQuestions] = useState<string[]>([]);
  const [combinedInsights, setCombinedInsights] = useState<Insight[] | null>(null);
  const [combinedSheetNames, setCombinedSheetNames] = useState<string[]>([]);
  const [combinedInsightQuestions, setCombinedInsightQuestions] = useState<string[]>([]);
  const [docInsights, setDocInsights] = useState<Insight[] | null>(null);
  const [docInsightsName, setDocInsightsName] = useState<string | null>(null);
  const [docInsightQuestions, setDocInsightQuestions] = useState<string[]>([]);


  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const currentScopedSourceIds = () => {
    const liveSheetIds = new Set(liveSheets.map((s: any) => s.id));
    const liveDocumentIds = new Set(liveDocuments.map((d: any) => d.id));
    return {
      sheetIds: Array.from(selected).filter((id) => liveSheets.length > 0 && liveSheetIds.has(id)),
      documentIds: Array.from(selectedDocs).filter((id) => liveDocuments.length > 0 && liveDocumentIds.has(id)),
    };
  };

  const sendAsk = (q: string) => {
    const scoped = currentScopedSourceIds();
    askMut.mutate({
      question: q,
      sheetIds: scoped.sheetIds,
      documentIds: scoped.documentIds,
      history: history.flatMap((t) => [
        { role: "user" as const, content: t.question },
        { role: "assistant" as const, content: t.answer },
      ]),
    });
  };

  const askMut = useMutation({
    mutationFn: (vars: {
      question: string;
      sheetIds: string[];
      documentIds: string[];
      history: { role: "user" | "assistant"; content: string }[];
      retryForCitations?: boolean;
      originalQuestion?: string;
    }) => {
      const q = vars.retryForCitations
        ? `REMINDER: your previous answer was rejected because it lacked citations. Repeat your answer for the question below, but every factual sentence MUST have an inline citation marker like [flags[F-0003]] or [sheet:<name> row <n>], and the answer MUST end with a "Sources:" list. If a fact can't be cited from the provided data, say "I don't have that in the current dashboard data." instead.\n\nQuestion: ${vars.originalQuestion ?? vars.question}`
        : vars.question;
      // Hard timeout: prevent indefinite "Thinking…" hangs when upstream
      // AI providers stall. 90s covers slow tool loops but bails on true hangs.
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Copilot timed out after 90s. Try a narrower question or fewer sources.")), 90_000)
      );
      return Promise.race([
        ask({
          data: {
            question: q,
            sheetIds: vars.sheetIds,
            documentIds: vars.documentIds,
            history: vars.history,
            strictMatch,
          },
        }),
        timeout,
      ]);

    },
    onMutate: (vars) => {
      if (!vars.retryForCitations) setQuestion("");
    },
    onSuccess: (res, vars) => {
      const displayedQuestion = vars.originalQuestion ?? vars.question;
      const validation = validateCitationsDetailed(res.answer);
      if (!validation.ok && !vars.retryForCitations) {
        toast.info("Answer rejected — missing citations. Retrying…");
        askMut.mutate({
          question: displayedQuestion,
          sheetIds: vars.sheetIds,
          documentIds: vars.documentIds,
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
          citationsMissing: !validation.ok,
          citationValidation: validation,
          retriedForCitations: vars.retryForCitations,
          toolTrace: (res as any).toolTrace ?? [],
          retrievalDiagnostics: (res as any).retrievalDiagnostics ?? [],
          citationOk: (res as any).citationOk ?? validation.ok,
          unmatchedTerms: (res as any).unmatchedTerms ?? [],
        },

      ]);
      if (!validation.ok && vars.retryForCitations) {
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
      setInsightQuestions((res as any).questions ?? []);
      if (res.insights.length === 0) toast.info("No notable findings detected for this sheet.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't generate insights"),
  });

  const combinedInsightsMut = useMutation({
    mutationFn: (sheetIds: string[]) => autoCombinedInsights({ data: { sheetIds } }),
    onSuccess: (res) => {
      setCombinedInsights(res.insights as any);
      setCombinedSheetNames(res.sheetNames ?? []);
      setCombinedInsightQuestions(res.questions ?? []);
      if (!res.insights.length) toast.info("No notable findings across the selected sheets.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't generate combined insights"),
  });



  const docInsightsMut = useMutation({
    mutationFn: (documentId: string) => autoDocInsights({ data: { documentId } }),
    onSuccess: (res) => {
      setDocInsights(res.insights);
      setDocInsightsName(res.documentName);
      setDocInsightQuestions((res as any).questions ?? []);
      if (res.insights.length === 0) toast.info("No notable findings detected for this document.");
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
    setCombinedInsights(null);
    setCombinedSheetNames([]);
    setCombinedInsightQuestions([]);

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
    !askMut.isPending;

  const regenerate = () => {
    if (history.length === 0 || askMut.isPending) return;
    const last = history[history.length - 1];
    const priorHistory = history.slice(0, -1);
    setHistory(priorHistory);
    const scoped = currentScopedSourceIds();
    askMut.mutate({
      question: last.question,
      sheetIds: scoped.sheetIds,
      documentIds: scoped.documentIds,
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
  const multiSheetIds = selected.size >= 2 ? Array.from(selected) : null;
  const singleDocId = selectedDocs.size === 1 && selected.size === 0 ? Array.from(selectedDocs)[0] : null;




  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 p-4 md:grid-cols-[260px_1fr] md:p-6">
      {/* Sidebar: sheet + document picker */}
      <aside className="space-y-3">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium">Sheets in context</h2>
            <span className="text-xs text-muted-foreground">
              {selected.size} selected{usingCachedSheets ? " · cached" : ""}
            </span>
          </div>
          {sheets.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : visibleSheets.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Register sheets first on the My Sheets page.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {visibleSheets.map((s: any) => (
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
            <span className="text-xs text-muted-foreground">
              {selectedDocs.size} selected{usingCachedDocuments ? " · cached" : ""}
            </span>
          </div>
          {documents.isLoading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : visibleDocuments.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              Upload documents on the Documents page.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {visibleDocuments.map((d: any) => (
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
              <LiveStatusBadge status={live} className="ml-1" />
              <AIStatusBadge className="ml-1" />
            </h1>

            <p className="mt-1 text-sm text-muted-foreground">
              Conversational AI over your sheets and documents. Follow-ups remember context.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/agent/planner"
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" /> Plan mode
            </Link>
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
            {insights && insightQuestions.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Suggested questions from this sheet
                </div>
                <div className="flex flex-wrap gap-2">
                  {insightQuestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => sendAsk(q)}
                      disabled={askMut.isPending}
                      className="rounded-full border bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Combined Auto-Insights across multiple selected sheets */}
        {multiSheetIds && history.length === 0 && (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="h-4 w-4 text-primary" /> Combined Auto-Insights
                <span className="text-xs font-normal text-muted-foreground">
                  · {multiSheetIds.length} sheets
                </span>
              </h3>
              <Button
                size="sm"
                variant={combinedInsights ? "ghost" : "default"}
                onClick={() => combinedInsightsMut.mutate(multiSheetIds)}
                disabled={combinedInsightsMut.isPending}
              >
                {combinedInsightsMut.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {combinedInsights ? "Regenerate" : "Generate"}
              </Button>
            </div>
            {!combinedInsights && !combinedInsightsMut.isPending && (
              <p className="text-xs text-muted-foreground">
                Copilot scans every selected sheet, merges duplicate findings, and tags each insight
                with its source sheet via a <span className="font-medium">[sheet:Name]</span> citation.
              </p>
            )}
            {combinedSheetNames.length > 0 && combinedInsights && (
              <div className="mb-2 flex flex-wrap gap-1">
                {combinedSheetNames.map((n) => (
                  <Badge key={n} variant="secondary" className="text-[10px]">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
            {combinedInsights && combinedInsights.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {combinedInsights.map((ins, i) => {
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
                  // Extract [sheet:Name] citations to render as chips beneath.
                  const cites = Array.from(ins.detail.matchAll(/\[sheet:([^\]]+)\]/g)).map((m) => m[1]);
                  const cleanDetail = ins.detail.replace(/\s*\[sheet:[^\]]+\]/g, "").trim();
                  return (
                    <div key={i} className={`rounded-md border p-3 text-sm ${tone}`}>
                      <div className="mb-1 flex items-start gap-1.5 font-medium">
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{ins.title}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{cleanDetail}</p>
                      {cites.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {cites.map((c) => (
                            <Badge key={c} variant="outline" className="text-[10px]">
                              {c}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {combinedInsights && combinedInsightQuestions.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Suggested questions across these sheets
                </div>
                <div className="flex flex-wrap gap-2">
                  {combinedInsightQuestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => sendAsk(q)}
                      disabled={askMut.isPending}
                      className="rounded-full border bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Auto-Insights for a single document */}

        {singleDocId && history.length === 0 && (
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="h-4 w-4 text-primary" /> Document Auto-Insights
                {docInsightsName && (
                  <span className="text-xs font-normal text-muted-foreground">· {docInsightsName}</span>
                )}
              </h3>
              <Button
                size="sm"
                variant={docInsights ? "ghost" : "default"}
                onClick={() => docInsightsMut.mutate(singleDocId)}
                disabled={docInsightsMut.isPending}
              >
                {docInsightsMut.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {docInsights ? "Regenerate" : "Generate"}
              </Button>
            </div>
            {!docInsights && !docInsightsMut.isPending && (
              <p className="text-xs text-muted-foreground">
                AI reads the document and surfaces key clauses, deadlines, obligations and risks —
                no question needed.
              </p>
            )}
            {docInsights && docInsights.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {docInsights.map((ins, i) => {
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
            {docInsights && docInsightQuestions.length > 0 && (
              <div className="mt-3 border-t pt-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Suggested questions from this document
                </div>
                <div className="flex flex-wrap gap-2">
                  {docInsightQuestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => sendAsk(q)}
                      disabled={askMut.isPending}
                      className="rounded-full border bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {q}
                    </button>
                  ))}
                </div>
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
                        <div className="flex-1 space-y-1">
                          <div className="font-medium text-destructive">
                            Answer rejected — grounding check failed.
                          </div>
                          {t.citationValidation && (
                            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                              {t.citationValidation.issues.map((issue) => {
                                switch (issue) {
                                  case "empty":
                                    return <li key={issue}>The model returned an empty answer.</li>;
                                  case "no_inline_citations":
                                    return (
                                      <li key={issue}>
                                        No inline citation markers found. Expected at least one
                                        {" "}<code className="rounded bg-background px-1">[sheet:&lt;name&gt; row &lt;n&gt;]</code>,
                                        {" "}<code className="rounded bg-background px-1">[flags[&lt;id&gt;]]</code>,
                                        {" or "}<code className="rounded bg-background px-1">[doc:&lt;name&gt; p.&lt;n&gt;]</code>.
                                      </li>
                                    );
                                  case "malformed_citations":
                                    return (
                                      <li key={issue}>
                                        {t.citationValidation!.malformed.length} malformed marker
                                        {t.citationValidation!.malformed.length === 1 ? "" : "s"}:{" "}
                                        {t.citationValidation!.malformed.slice(0, 3).map((raw, mi) => (
                                          <code key={mi} className="mr-1 rounded bg-background px-1">[{raw}]</code>
                                        ))}
                                        {t.citationValidation!.malformed.length > 3 && "…"}
                                      </li>
                                    );
                                  case "no_sources_section":
                                    return (
                                      <li key={issue}>
                                        Missing <span className="font-medium">Sources:</span> section at the end
                                        of the answer.
                                      </li>
                                    );
                                  case "empty_sources_section":
                                    return (
                                      <li key={issue}>
                                        <span className="font-medium">Sources:</span> section is present but
                                        contains no entries.
                                      </li>
                                    );
                                  case "uncited_in_sources":
                                    return (
                                      <li key={issue}>
                                        {t.citationValidation!.uncited.length} inline marker
                                        {t.citationValidation!.uncited.length === 1 ? "" : "s"} not repeated
                                        in the Sources list:{" "}
                                        {t.citationValidation!.uncited.slice(0, 3).map((raw, mi) => (
                                          <code key={mi} className="mr-1 rounded bg-background px-1">[{raw}]</code>
                                        ))}
                                        {t.citationValidation!.uncited.length > 3 && "…"}
                                      </li>
                                    );
                                  default:
                                    return null;
                                }
                              })}
                            </ul>
                          )}
                          {t.retriedForCitations && (
                            <div className="italic text-muted-foreground">
                              Automatic retry with a stricter reminder also failed — the answer below is shown
                              for transparency but should not be trusted.
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={askMut.isPending}
                          onClick={() => {
                            const scoped = currentScopedSourceIds();
                            askMut.mutate({
                              question: t.question,
                              sheetIds: scoped.sheetIds,
                              documentIds: scoped.documentIds,
                              history: history.slice(0, i).flatMap((x) => [
                                { role: "user" as const, content: x.question },
                                { role: "assistant" as const, content: x.answer },
                              ]),
                              retryForCitations: true,
                              originalQuestion: t.question,
                            });
                          }}
                        >
                          <RefreshCw className="mr-1 h-3 w-3" /> Re-ask with citations
                        </Button>
                      </div>
                    )}

                    {t.retrievalDiagnostics && t.retrievalDiagnostics.length > 0 && (
                      <GroundingDiagnostics diagnostics={t.retrievalDiagnostics} />
                    )}

                    {t.toolTrace && t.toolTrace.length > 0 && (
                      <ToolCallTrace trace={t.toolTrace} />
                    )}

                    <div className="prose prose-sm dark:prose-invert max-w-none prose-table:my-2 prose-p:my-1.5 prose-headings:my-2">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          // Replace bare text nodes with citation-aware React nodes.
                          p: ({ children, ...props }) => (
                            <p {...props}>{decorateChildren(children, t.sources)}</p>
                          ),
                          li: ({ children, ...props }) => (
                            <li {...props}>{decorateChildren(children, t.sources)}</li>
                          ),
                          td: ({ children, ...props }) => (
                            <td {...props}>{decorateChildren(children, t.sources)}</td>
                          ),
                        }}
                      >
                        {stripCitations(t.answer)}
                      </ReactMarkdown>
                    </div>
                    <PrimarySourceLink answer={t.answer} sources={t.sources} />

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
                    <GroundingInspector answer={t.answer} sources={t.sources} />
                    {t.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {t.sources.map((s) => (
                          <Badge key={s.id} variant="outline" className="text-xs">
                            {s.name} ({s.rowsUsed > 0
                              ? `${s.rowsUsed}${s.truncated ? "+" : ""} matched rows`
                              : `${(s.rowsTotal ?? 0).toLocaleString()} scoped rows · 0 matched`})
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
              <ThinkingElapsed startedAt={askMut.submittedAt} />
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 px-2 text-xs"
                onClick={() => askMut.reset()}
              >
                Cancel
              </Button>
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
          <div className="mt-2 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-4">
              <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                <Switch checked={strictMatch} onCheckedChange={setStrictMatch} aria-label="Strict match" />
                <span>
                  Strict match
                  <span className="ml-1 text-[10px] opacity-70">
                    {strictMatch ? "(exact phrase only — no surname fallback)" : "(broader keyword match)"}
                  </span>
                </span>
              </label>
            </div>
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
