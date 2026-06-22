import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";

import { Sparkles, Send, RefreshCcw, FileText, MessageSquareWarning, Bell, Sheet as SheetIcon, Calculator, Bot, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import type { SheetSource } from "@/lib/notebook/compute";
import { classify, parseQuestion } from "@/lib/notebook/router";
import { evaluate } from "@/lib/notebook/compute";
import { buildContext, type ConcernLite, type ReminderLite } from "@/lib/notebook/retrieve";
import { verifyCitations } from "@/lib/notebook/verify";
import { callChat, loadHistory, loadSources, upsertSource, summarizeSource, suggestQuestions, tokenFromBase } from "@/lib/notebook/client";
import type { Citation, ChatMessage } from "@/lib/notebook/types";

type Sheet = {
  label: string; columns?: { name: string }[]; rows?: Record<string, unknown>[]; row_count?: number;
};

export type NotebookCopilotProps = {
  base: string;
  sheets: Sheet[];
  concerns: ConcernLite[];
  reminders: ReminderLite[];
  onJumpToSheetRow?: (sheet: string, row: number) => void;
  onOpenConcern?: (id?: string) => void;
};

type SrcState = { type: "sheet" | "concerns" | "reminders"; label: string; row_count: number; enabled: boolean; summary?: string };

export default function NotebookCopilot({ base, sheets, concerns, reminders, onJumpToSheetRow, onOpenConcern }: NotebookCopilotProps) {
  const token = useMemo(() => tokenFromBase(base), [base]);

  // Build initial source list from the live link payload
  const initialSources: SrcState[] = useMemo(() => {
    const out: SrcState[] = sheets.map((s) => ({
      type: "sheet", label: s.label, row_count: s.row_count ?? s.rows?.length ?? 0, enabled: true,
    }));
    out.push({ type: "concerns", label: "Concerns", row_count: concerns.length, enabled: true });
    out.push({ type: "reminders", label: "Reminders", row_count: reminders.length, enabled: true });
    return out;
  }, [sheets, concerns, reminders]);

  const [sources, setSources] = useState<SrcState[]>(initialSources);
  useEffect(() => { setSources(initialSources); }, [initialSources]);

  // Load persisted source enable/summary state
  useEffect(() => {
    if (!token) return;
    loadSources(token).then((rows) => {
      if (!rows.length) return;
      setSources((cur) =>
        cur.map((s) => {
          const found = rows.find((r) => r.type === s.type && r.label === s.label);
          return found ? { ...s, enabled: found.enabled ?? s.enabled, summary: found.summary ?? undefined } : s;
        }),
      );
    }).catch(() => undefined);
  }, [token]);

  const sheetSources: SheetSource[] = useMemo(
    () =>
      sheets
        .filter((s) => sources.find((x) => x.type === "sheet" && x.label === s.label)?.enabled)
        .map((s) => ({
          label: s.label,
          columns: (s.columns ?? []).map((c) => c.name),
          rows: s.rows ?? [],
        })),
    [sheets, sources],
  );
  const enabledConcerns = sources.find((s) => s.type === "concerns")?.enabled ? concerns : [];
  const enabledReminders = sources.find((s) => s.type === "reminders")?.enabled ? reminders : [];

  const toggleSource = async (type: SrcState["type"], label: string, next: boolean) => {
    setSources((cur) => cur.map((s) => (s.type === type && s.label === label ? { ...s, enabled: next } : s)));
    try {
      await upsertSource(token, { type, label, enabled: next, row_count: sources.find((s) => s.type === type && s.label === label)?.row_count ?? 0 });
    } catch (e) {
      console.warn("persist toggle failed", e);
    }
  };

  // Chat history
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHist, setLoadingHist] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoadingHist(true);
    loadHistory(token)
      .then((rows) => {
        if (!alive) return;
        setMessages(
          rows.map((r) => ({
            id: r.id, role: r.role as "user" | "assistant", content: r.content,
            citations: (r.citations as Citation[]) ?? [], generated_by: r.generated_by, created_at: r.created_at,
          })),
        );
      })
      .catch(() => undefined)
      .finally(() => alive && setLoadingHist(false));
    return () => { alive = false; };
  }, [token]);

  // Suggestions
  const suggestQ = useQuery({
    queryKey: ["notebook-suggest", token, sources.filter((s) => s.enabled).map((s) => `${s.type}:${s.label}`).join("|")],
    queryFn: () =>
      suggestQuestions({
        token,
        enabled_sources: sources
          .filter((s) => s.enabled)
          .map((s) => ({
            type: s.type, label: s.label, row_count: s.row_count,
            columns: s.type === "sheet" ? sheets.find((x) => x.label === s.label)?.columns?.map((c) => c.name) : undefined,
          })),
      }),
    enabled: !!token && sources.some((s) => s.enabled),
    staleTime: 5 * 60 * 1000,
  });

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length, sending]);

  const handleAsk = async (q: string) => {
    const question = q.trim();
    if (!question || sending) return;
    setSending(true);
    setInput("");
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: question };
    setMessages((m) => [...m, userMsg]);
    try {
      const kind = classify(question);
      const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));

      if (kind === "quantitative") {
        const parsed = parseQuestion(question, sheetSources);
        if (parsed) {
          const computed = evaluate(parsed, sheetSources);
          if (computed) {
            const resp = await callChat({ token, question, computedResult: computed, history });
            const verified = verifyCitations({
              citations: resp.citations, sheets: sheetSources, concerns: enabledConcerns, reminders: enabledReminders,
            });
            setOffline(!!resp.offline);
            setMessages((m) => [
              ...m,
              { id: `a-${Date.now()}`, role: "assistant", content: resp.text, citations: verified, generated_by: resp.generated_by },
            ]);
            return;
          }
        }
        // Parsing failed — fall through to qualitative
      }

      const context = buildContext({ question, sheets: sheetSources, concerns: enabledConcerns, reminders: enabledReminders });
      const resp = await callChat({ token, question, contextItems: context, history });
      const verified = verifyCitations({
        citations: resp.citations, sheets: sheetSources, concerns: enabledConcerns, reminders: enabledReminders,
      });
      setOffline(!!resp.offline);
      setMessages((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: "assistant", content: resp.text, citations: verified, generated_by: resp.generated_by },
      ]);
    } catch (e) {
      toast.error((e as Error).message || "Co-pilot error");
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: "Sorry — something went wrong. Please try again.", generated_by: "computed" }]);
    } finally {
      setSending(false);
    }
  };

  const handleGenerateSummary = async (s: SrcState) => {
    try {
      let sample: unknown = [];
      if (s.type === "sheet") {
        const sheet = sheets.find((x) => x.label === s.label);
        sample = { columns: sheet?.columns?.map((c) => c.name), rows: (sheet?.rows ?? []).slice(0, 5) };
      } else if (s.type === "concerns") sample = concerns.slice(0, 5);
      else sample = reminders.slice(0, 5);
      const { summary } = await summarizeSource({ token, type: s.type, label: s.label, sample, row_count: s.row_count });
      setSources((cur) => cur.map((x) => (x.type === s.type && x.label === s.label ? { ...x, summary } : x)));
    } catch (e) {
      toast.error((e as Error).message || "Summary failed");
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      {/* Sources panel */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><FileText className="h-4 w-4" /> Sources</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 p-3">
          {sources.map((s) => {
            const Icon = s.type === "sheet" ? SheetIcon : s.type === "concerns" ? MessageSquareWarning : Bell;
            return (
              <div key={`${s.type}:${s.label}`} className="rounded-lg border border-border/60 p-2.5">
                <div className="flex items-start gap-2">
                  <Checkbox checked={s.enabled} onCheckedChange={(v) => toggleSource(s.type, s.label, !!v)} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate">{s.label}</span>
                      <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px]">{s.row_count}</Badge>
                    </div>
                    {s.summary ? (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-3">{s.summary}</p>
                    ) : (
                      <Button variant="ghost" size="sm" className="mt-1 h-6 px-1.5 text-xs" onClick={() => handleGenerateSummary(s)}>
                        Generate summary
                      </Button>
                    )}
                    {s.summary && (
                      <Button variant="ghost" size="sm" className="mt-1 h-6 px-1.5 text-xs text-muted-foreground" onClick={() => handleGenerateSummary(s)}>
                        <RefreshCcw className="mr-1 h-3 w-3" /> Regenerate
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Chat panel */}
      <Card className="flex h-[70vh] flex-col rounded-2xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" /> Co-pilot
            {offline && (
              <Badge variant="outline" className="ml-2 gap-1 text-[10px]">
                <AlertCircle className="h-3 w-3" /> Offline mode
              </Badge>
            )}
          </CardTitle>
          {offline && (
            <p className="text-xs text-muted-foreground">
              Running in offline mode — numeric answers are exact; set GEMINI_API_KEY for full AI explanations.
            </p>
          )}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {/* Suggestions */}
          {(suggestQ.data?.suggestions?.length ?? 0) > 0 && messages.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestQ.data!.suggestions.map((q) => (
                <Button key={q} variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleAsk(q)} disabled={sending}>
                  {q}
                </Button>
              ))}
            </div>
          )}

          {/* History */}
          <div className="flex-1 overflow-y-auto rounded-lg border bg-muted/20 p-3" ref={scrollRef}>
            {loadingHist ? (
              <div className="space-y-2"><Skeleton className="h-12 w-2/3" /><Skeleton className="h-12 w-1/2 ml-auto" /></div>
            ) : messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Ask anything about your selected sources.</p>
            ) : (
              <div className="space-y-3">
                {messages.map((m) => (
                  <MessageBubble
                    key={m.id}
                    msg={m}
                    onCitationClick={(c) => {
                      if (c.type === "sheet" && c.sheet && typeof c.row === "number") onJumpToSheetRow?.(c.sheet, c.row);
                      else if (c.type === "concern") onOpenConcern?.(c.id);
                    }}
                  />
                ))}
                {sending && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="h-3 w-3 animate-pulse" /> Thinking…
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); handleAsk(input); }}
            className="flex items-end gap-2"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question grounded in your selected sources…"
              rows={2}
              className="resize-none"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(input); } }}
              disabled={sending}
            />
            <Button type="submit" size="sm" disabled={sending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function MessageBubble({ msg, onCitationClick }: { msg: ChatMessage; onCitationClick: (c: Citation) => void }) {
  const isUser = msg.role === "user";
  const badge = msg.generated_by?.startsWith("computed") ? "Computed" : "AI";
  const BadgeIcon = badge === "Computed" ? Calculator : Bot;
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${isUser ? "bg-primary text-primary-foreground" : "bg-card border"}`}>
        {!isUser && (
          <div className="mb-1 flex items-center gap-1">
            <Badge variant="outline" className="h-4 gap-1 px-1 text-[9px]"><BadgeIcon className="h-2.5 w-2.5" /> {badge}</Badge>
          </div>
        )}
        <div className="whitespace-pre-wrap">{msg.content}</div>
        {!isUser && (msg.citations?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {msg.citations!.map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onCitationClick(c)}
                className="rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {citationLabel(c)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function citationLabel(c: Citation): string {
  if (c.type === "sheet") return `${c.sheet} · row ${typeof c.row === "number" ? c.row + 1 : "?"}`;
  if (c.type === "concern") return `Concern${c.id ? ` #${c.id.slice(0, 6)}` : ""}`;
  return `Reminder${c.id ? ` #${c.id.slice(0, 6)}` : ""}`;
}
