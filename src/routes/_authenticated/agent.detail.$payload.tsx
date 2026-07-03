import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft, Mail, Send, User as UserIcon, Layers, AlertTriangle,
  ExternalLink, MessageSquare, History, CheckCircle2, MessageCircle,
  Sparkles, Save, Bot, Copy, Lightbulb, ListChecks, Download, Pencil,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { decodeDetailPayload, type DetailPayload, type DetailContextRow } from "@/lib/agent-detail-payload";
import { sendAlert } from "@/lib/alerts.functions";
import { getSourceTimeline, type TimelineEvent } from "@/lib/source-timeline.functions";
import { fetchMyRoles } from "@/lib/route-guards";
import { generateGeminiFn } from "@/lib/gemini.functions";

export const Route = createFileRoute("/_authenticated/agent/detail/$payload")({
  head: () => ({ meta: [{ title: "Action detail — DelayLens" }] }),
  // Auth is already enforced by the `_authenticated` layout. We intentionally
  // do NOT re-check roles here: `supabase.auth.getUser()` can transiently fail
  // during quick client-side navigations and would incorrectly bounce the user
  // back to the dashboard. Any unauthenticated visitor is redirected to /auth
  // by the parent guard before this loader ever runs.
  component: DetailPage,
});

const TONE: Record<string, string> = {
  high: "text-rose-700 bg-rose-500/10 border-rose-500/30",
  med: "text-amber-800 bg-amber-500/10 border-amber-500/30",
  low: "text-slate-700 bg-slate-500/10 border-slate-500/30",
  ok: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
};

type ChatMsg = { role: "user" | "assistant"; content: string; citations?: number[]; ranked?: DetailContextRow[] };

function DetailPage() {
  const { payload: encoded } = Route.useParams();
  const data = useMemo<DetailPayload | null>(() => {
    try { return decodeDetailPayload(encoded); } catch { return null; }
  }, [encoded]);

  const sendFn = useServerFn(sendAlert);
  const timelineFn = useServerFn(getSourceTimeline);
  const genFn = useServerFn(generateGeminiFn);
  const qc = useQueryClient();

  const activityTitle = (data?.row && (data.row["Activity List"] || data.row["Process Descriptions"] || data.row["Process"])) as string | undefined
    ?? data?.title
    ?? "(unnamed)";
  const responsibleEmail = (data?.email
    ?? (data?.row?.["Responsible Person Mail ID"] as string | undefined)
    ?? (data?.row?.["approvers email id"] as string | undefined)
    ?? "").trim();
  const responsibleName = (data?.person
    ?? (data?.row?.["Responsible Person"] as string | undefined)
    ?? (data?.row?.["Responsibility"] as string | undefined)
    ?? (data?.row?.["approvers name"] as string | undefined)
    ?? "").trim();

  const context = data?.contextRows ?? [];
  const metrics = data?.metrics ?? [];

  // ── Auto-derived recommendations (data-backed, no LLM required)
  const derivedRecs = useMemo(() => deriveRecommendations(data, context), [data, context]);

  // ── Email drafter
  const [subject, setSubject] = useState(`Action needed: ${String(activityTitle).slice(0, 120)}`);
  const [body, setBody] = useState(() => defaultBody(data, activityTitle, responsibleName));
  const [drafting, setDrafting] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<{ subject: string; body: string; at: number }[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(`agent:drafts:${encoded}`) ?? "[]"); }
    catch { return []; }
  });

  async function draftWithAI() {
    if (!data) return;
    setDrafting(true);
    try {
      const sample = context.slice(0, 12).map((r, i) => `#${i + 1} ${r.activity} · ${r.person ?? "?"} · ${r.stage ?? "?"} · ${r.status ?? "?"} · TAT ${r.tat ?? "?"} / took ${r.taken ?? "?"} · delay ${r.delay ?? 0}d`).join("\n");
      const sys = "You draft short, respectful, action-oriented business emails for delivery teams. Return ONLY a JSON object: {\"subject\": string, \"body\": string}. Body is plain text (no markdown), 90–160 words, ends with a clear ask (recovery date + blockers). Never invent facts.";
      const prompt = `Recipient: ${responsibleName || "(unknown)"} <${responsibleEmail || "(no email)"}>
Project: ${data.projectLabel ?? "—"}
Focus: ${data.title}
Severity: ${data.severity ?? "med"}
Summary: ${data.detail ?? ""}
Person: ${data.person ?? "—"} | Stage: ${data.stage ?? "—"}
Key metrics: ${metrics.map(m => `${m.label}=${m.value}`).join(", ") || "—"}
Sample of related records:
${sample || "(none)"}
Return the JSON now.`;
      const res = await genFn({ data: { system: sys, prompt, temperature: 0.3 } });
      const parsed = extractJson(res.text);
      if (parsed?.subject && parsed?.body) {
        setSubject(String(parsed.subject).slice(0, 200));
        setBody(String(parsed.body));
        toast.success("Draft generated");
      } else {
        // Fall back to raw text as body
        setBody(res.text.trim());
        toast.success("Draft generated (raw)");
      }
    } catch (e) {
      toast.error((e as Error).message || "Draft failed");
    } finally {
      setDrafting(false);
    }
  }

  function saveDraft() {
    const next = [{ subject, body, at: Date.now() }, ...savedDrafts].slice(0, 10);
    setSavedDrafts(next);
    if (typeof window !== "undefined") localStorage.setItem(`agent:drafts:${encoded}`, JSON.stringify(next));
    toast.success("Draft saved");
  }

  const alertMut = useMutation({
    mutationFn: async (channel: "email" | "message") => {
      const flag = {
        id: `agent-${(data?.source ?? "action").toLowerCase()}-${Date.now()}`,
        activity: String(activityTitle).slice(0, 500),
        stage: (data?.stage ?? "").slice(0, 200) || null,
        severity: data?.severity ?? "med",
        source: (data?.projectLabel ?? data?.source ?? "Agent").slice(0, 200),
        root_cause: subject.slice(0, 2000),
        reason: `${channel === "email" ? "[Email]" : "[In-app]"} ${body}`.slice(0, 2000),
        responsible_email: responsibleEmail || null,
        responsible_name: responsibleName || null,
        extra_recipients: [] as { email: string; name?: string | null }[],
      };
      return sendFn({ data: { flag } });
    },
    onSuccess: (_res, channel) => {
      toast.success(channel === "email" ? "Email dispatched" : "Message sent");
      qc.invalidateQueries({ queryKey: ["source-timeline", activityTitle, data?.stage ?? null] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const timelineQ = useQuery({
    queryKey: ["source-timeline", activityTitle, data?.stage ?? null],
    queryFn: () => timelineFn({ data: { activity: String(activityTitle), stage: data?.stage ?? null } }),
    enabled: !!activityTitle,
    refetchInterval: 30_000,
  });

  // ── Chatbot scoped to context
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const scopeTableRef = useRef<HTMLDivElement | null>(null);
  const draftPanelRef = useRef<HTMLDivElement | null>(null);
  const [highlightRow, setHighlightRow] = useState<string | null>(null);

  // Jump a chat citation to its row in the scope table and flash-highlight it.
  const jumpToRow = (row: DetailContextRow) => {
    const key = rowKey(row);
    setHighlightRow(key);
    const el = document.getElementById(`scope-row-${key}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    else scopeTableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => setHighlightRow((h) => (h === key ? null : h)), 2400);
  };

  const askMut = useMutation({
    mutationFn: async (q: string) => {
      if (!data) throw new Error("No context");
      const ranked = rankRows(context, q).slice(0, 8);
      const numbered = ranked.map((r, i) => `[${i + 1}] ${r.activity} · person: ${r.person ?? "—"} · stage: ${r.stage ?? "—"} · status: ${r.status ?? "—"} · TAT ${r.tat ?? "—"} / took ${r.taken ?? "—"} · delay ${r.delay ?? 0}d`).join("\n");
      const sys = `You are a scoped analyst. You may ONLY use the FACTS and RECORDS below. If the answer is not derivable from them, say so plainly. Cite records inline like [1], [2] whenever you state a fact from them. Keep answers under 120 words.`;
      const prompt = `SCOPE
Title: ${data.title}
Person: ${data.person ?? "—"} | Stage: ${data.stage ?? "—"} | Project: ${data.projectLabel ?? "—"}
Metrics: ${metrics.map(m => `${m.label}=${m.value}`).join(", ") || "—"}
Detail: ${data.detail ?? "—"}

RECORDS (${ranked.length} of ${context.length})
${numbered || "(no records in scope)"}

QUESTION: ${q}`;
      const res = await genFn({ data: { system: sys, prompt, temperature: 0.2 } });
      const text = (res.text || "").trim();
      const cites = Array.from(new Set(Array.from(text.matchAll(/\[(\d+)\]/g)).map(m => Number(m[1])))).filter(n => n >= 1 && n <= ranked.length);
      return { text, citations: cites, ranked };
    },
    onSuccess: (r) => {
      setChat(c => [...c, { role: "assistant", content: r.text, citations: r.citations, ranked: r.ranked }]);
      requestAnimationFrame(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }));
    },
    onError: (e) => {
      setChat(c => [...c, { role: "assistant", content: `⚠️ ${(e as Error).message}` }]);
    },
  });

  function ask(q: string) {
    const t = q.trim();
    if (!t) return;
    setChat(c => [...c, { role: "user", content: t }]);
    setQuestion("");
    askMut.mutate(t);
  }

  // ── One-click actions on recommendations
  function draftFromRecommendation(rec: string) {
    setSubject(`Action needed: ${String(activityTitle).slice(0, 120)}`);
    setBody(
      [
        `Hi${responsibleName ? " " + responsibleName : ""},`,
        "",
        rec,
        "",
        `Context: ${data?.title ?? ""}`,
        data?.stage ? `Stage: ${data.stage}` : "",
        data?.projectLabel ? `Project: ${data.projectLabel}` : "",
        "",
        "Please confirm a recovery date and any blockers. Reply to this alert directly.",
      ].filter(Boolean).join("\n")
    );
    draftPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    toast.success("Draft prefilled from recommendation");
  }

  // ── Export the whole detail as CSV (metrics, recommendations, timeline, chat + citations)
  function exportCsv() {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`# Detail export · ${new Date().toISOString()}`);
    lines.push(`# Title,${esc(data?.title ?? "")}`);
    lines.push(`# Project,${esc(data?.projectLabel ?? "")}`);
    lines.push(`# Person,${esc(data?.person ?? "")}`);
    lines.push(`# Stage,${esc(data?.stage ?? "")}`);
    lines.push(`# Severity,${esc(data?.severity ?? "")}`);
    lines.push("");
    lines.push("Section,Label,Value");
    metrics.forEach((m) => lines.push(`metric,${esc(m.label)},${esc(String(m.value))}`));
    derivedRecs.forEach((r, i) => lines.push(`recommendation,#${i + 1},${esc(r)}`));
    (timelineQ.data ?? []).forEach((e) => {
      lines.push(`timeline,${esc(new Date(e.at).toLocaleString())},${esc(`${e.kind} · ${e.title}${e.actor.name || e.actor.email ? ` (by ${e.actor.name || e.actor.email})` : ""}${e.body ? " — " + e.body : ""}`)}`);
    });
    chat.forEach((m, i) => {
      lines.push(`chat,${esc(m.role + " #" + (i + 1))},${esc(m.content)}`);
      (m.citations ?? []).forEach((n) => {
        const src = m.ranked?.[n - 1];
        if (src) lines.push(`citation,${esc(`[${n}] from chat #${i + 1}`)},${esc(`${src.activity} · ${src.person ?? "—"} · ${src.stage ?? "—"} · delay ${src.delay ?? 0}d`)}`);
      });
    });
    (context.length ? context : []).forEach((r, i) => {
      lines.push(`scope-record,#${i + 1},${esc(`${r.activity} · ${r.person ?? "—"} · ${r.stage ?? "—"} · ${r.status ?? "—"} · TAT ${r.tat ?? "—"} / took ${r.taken ?? "—"} · delay ${r.delay ?? 0}d`)}`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safe = (data?.title ?? "detail").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60);
    a.download = `${safe}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast.success("Exported");
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 space-y-4">
        <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Link>
        <Card className="p-6 text-sm text-muted-foreground">This action link is malformed or expired.</Card>
      </main>
    );
  }

  const rowEntries = data.row ? Object.entries(data.row).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "") : [];

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:py-8 space-y-6">
      {/* TOP NAV */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <Link
          to="/agent"
          className="inline-flex min-w-0 items-center gap-1 rounded text-sm text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">Back to dashboard</span>
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground">
          {data.projectLabel && <Badge variant="outline" className="max-w-[220px] truncate">{data.projectLabel}</Badge>}
          {data.source && <Badge variant="secondary">{data.source}</Badge>}
          <Badge variant="outline" className="capitalize">{data.kind}</Badge>
          <Button size="sm" variant="outline" onClick={exportCsv} aria-label="Export detail as CSV">
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </Button>
        </div>
      </div>

      {/* HEADER */}
      <Card className={`overflow-hidden border ${TONE[data.severity ?? "med"]}`}>
        <CardContent className="p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-5 w-5 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">{data.source ?? "Action"}</div>
              <h1 className="mt-0.5 break-words text-xl font-semibold leading-tight md:text-2xl">{data.title}</h1>
              {data.detail && <p className="mt-2 text-sm opacity-90">{data.detail}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {data.person && <Chip icon={<UserIcon className="h-3 w-3" aria-hidden />}>{data.person}</Chip>}
                {data.stage && <Chip icon={<Layers className="h-3 w-3" aria-hidden />}>{data.stage}</Chip>}
                {responsibleEmail && <Chip icon={<Mail className="h-3 w-3" aria-hidden />}>{responsibleEmail}</Chip>}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* METRICS */}
      {metrics.length > 0 && (
        <section aria-label="Key metrics">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {metrics.map((m) => (
              <Card key={m.label} className={`border ${m.tone ? TONE[m.tone] : "border-border/60"}`}>
                <CardContent className="p-3.5">
                  <div className="text-[10px] font-bold uppercase tracking-widest opacity-70">{m.label}</div>
                  <div className="mt-1 text-xl font-semibold leading-none tabular-nums">{m.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* RECOMMENDATIONS */}
      {derivedRecs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden /> Data-backed recommendations
              <Badge variant="secondary" className="ml-1">{derivedRecs.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {derivedRecs.map((r, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="flex-1">{r}</span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => draftFromRecommendation(r)}
                      aria-label={`Draft message from recommendation ${i + 1}`}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden /> Draft
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => { draftFromRecommendation(r); alertMut.mutate("message"); }}
                      disabled={alertMut.isPending}
                      aria-label={`Send in-app message for recommendation ${i + 1}`}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden /> Send
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        {/* SOURCE ROW / CONTEXT ROWS */}
        <Card className="lg:col-span-3" ref={scopeTableRef as never}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ExternalLink className="h-4 w-4" aria-hidden /> {rowEntries.length ? "Source record" : "Records in scope"}
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                {rowEntries.length ? `${rowEntries.length} fields` : `${context.length} rows`}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rowEntries.length > 0 ? (
              <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                {rowEntries.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(120px,32%)_1fr] gap-3 px-3 py-2 text-sm">
                    <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{k}</div>
                    <div className="whitespace-pre-wrap break-words">{String(v)}</div>
                  </div>
                ))}
              </div>
            ) : context.length > 0 ? (
              <ScopeRowsTable rows={context} highlightId={highlightRow} />
            ) : (
              <p className="text-sm text-muted-foreground">
                This action was derived from aggregated metrics ({data.source}). Use the email drafter to notify the owner.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ACTION PANEL */}
        <Card className="lg:col-span-2" ref={draftPanelRef as never}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="h-4 w-4 text-primary" aria-hidden /> Draft &amp; send email
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="to" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</label>
              <Input id="to" value={responsibleEmail || "(no email on record — in-app message only)"} readOnly className="text-sm" />
            </div>
            <div className="space-y-1">
              <label htmlFor="subject" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</label>
              <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label htmlFor="body" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Message</label>
              <Textarea id="body" rows={9} value={body} onChange={(e) => setBody(e.target.value)} className="resize-y" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={draftWithAI}
                disabled={drafting}
                aria-label="Draft this email with AI from the context"
              >
                <Sparkles className={`h-4 w-4 ${drafting ? "animate-pulse" : ""}`} aria-hidden />
                {drafting ? "Drafting…" : "Draft with AI"}
              </Button>
              <Button size="sm" variant="outline" onClick={saveDraft} aria-label="Save draft">
                <Save className="h-4 w-4" aria-hidden /> Save draft
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void navigator.clipboard?.writeText(`${subject}\n\n${body}`); toast.success("Copied"); }}
                aria-label="Copy subject and body to clipboard"
              >
                <Copy className="h-4 w-4" aria-hidden /> Copy
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
              <Button
                size="sm"
                onClick={() => alertMut.mutate("email")}
                disabled={alertMut.isPending || !responsibleEmail}
              >
                <Mail className="h-4 w-4" aria-hidden /> Send email
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => alertMut.mutate("message")}
                disabled={alertMut.isPending}
              >
                <Send className="h-4 w-4" aria-hidden /> In-app message
              </Button>
            </div>
            {savedDrafts.length > 0 && (
              <details className="pt-2">
                <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Saved drafts ({savedDrafts.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {savedDrafts.map((d, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => { setSubject(d.subject); setBody(d.body); toast.success("Draft loaded"); }}
                        className="min-w-0 flex-1 truncate rounded border border-border/60 bg-muted/30 px-2 py-1 text-left hover:bg-muted/60"
                      >
                        {d.subject || "(no subject)"} · {new Date(d.at).toLocaleString()}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
              Delivered through the alerts pipeline. Replies show up in your Alerts inbox and on the timeline below.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* SCOPED CHAT */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bot className="h-4 w-4 text-primary" aria-hidden /> Ask about {data.person ? <b>{data.person}</b> : data.stage ? <b>{data.stage}</b> : "this scope"}
            <span className="ml-auto text-[11px] font-normal text-muted-foreground">
              Grounded on {context.length} record{context.length === 1 ? "" : "s"}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ScrollArea className="h-72 rounded-md border border-border/60 bg-muted/20 p-3">
            {chat.length === 0 ? (
              <div className="grid h-full place-items-center text-center text-xs text-muted-foreground">
                <div className="max-w-sm space-y-2">
                  <p>The assistant only uses the {context.length} record{context.length === 1 ? "" : "s"} in this scope. Try:</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {suggestedPrompts(data).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => ask(p)}
                        className="rounded-full border border-border/60 bg-background px-2 py-0.5 text-[11px] hover:bg-muted"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <ul className="space-y-3" role="log" aria-live="polite" aria-relevant="additions">
                {chat.map((m, i) => (
                  <li key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-background border border-border/60"
                    }`}>
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                      {m.citations && m.citations.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1" aria-label="Citations">
                          {m.citations.map(n => {
                            const src = m.ranked?.[n - 1];
                            const label = src
                              ? `Citation ${n}: ${src.activity}${src.person ? " — " + src.person : ""}`
                              : `Citation ${n}`;
                            return (
                              <button
                                key={n}
                                type="button"
                                onClick={() => src && jumpToRow(src)}
                                title={label}
                                aria-label={`Jump to ${label}`}
                                disabled={!src}
                                className="inline-flex h-5 items-center rounded border border-border/60 bg-background px-1 text-[10px] font-medium text-foreground hover:bg-amber-500/20 hover:border-amber-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                [{n}]
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
                {askMut.isPending && (
                  <li className="flex justify-start"><div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-sm text-muted-foreground">Thinking…</div></li>
                )}
                <div ref={chatEndRef} />
              </ul>
            )}
          </ScrollArea>
          <form
            onSubmit={(e) => { e.preventDefault(); ask(question); }}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
          >
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={context.length ? "Ask a question grounded on this scope…" : "No records in scope yet"}
              disabled={context.length === 0 || askMut.isPending}
              aria-label="Ask about this scope"
            />
            <Button type="submit" disabled={!question.trim() || askMut.isPending} aria-label="Send question">
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* TIMELINE */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-primary" aria-hidden /> Communication &amp; flag timeline
            {timelineQ.data && <Badge variant="secondary">{timelineQ.data.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TimelineList events={timelineQ.data ?? []} loading={timelineQ.isLoading} />
        </CardContent>
      </Card>
    </main>
  );
}

// ────────────────────── helpers ──────────────────────

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-background/60 px-2 py-1">
      {icon}<span className="truncate max-w-[240px]">{children}</span>
    </span>
  );
}

function rowKey(r: DetailContextRow) {
  return `${(r.activity || "").slice(0, 40)}|${r.person ?? ""}|${r.stage ?? ""}`
    .replace(/[^a-z0-9|]+/gi, "-").toLowerCase();
}

function ScopeRowsTable({ rows, highlightId }: { rows: DetailContextRow[]; highlightId: string | null }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full text-sm">
        <caption className="sr-only">Records in scope, sorted by delay.</caption>
        <thead className="bg-muted/40 text-xs">
          <tr>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">#</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Activity</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Person</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Stage</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Status</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Delay</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const key = rowKey(r);
            const hit = highlightId === key;
            return (
              <tr
                key={i}
                id={`scope-row-${key}`}
                className={`border-t border-border/60 transition-colors ${hit ? "bg-amber-500/20 ring-2 ring-amber-500/60" : ""}`}
              >
                <td className="px-2 py-1.5 text-xs text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="max-w-[280px] truncate px-2 py-1.5" title={r.activity}>{r.activity}</td>
                <td className="px-2 py-1.5 text-xs">{r.person ?? "—"}</td>
                <td className="px-2 py-1.5 text-xs">{r.stage ?? "—"}</td>
                <td className="px-2 py-1.5 text-xs">{r.status ?? "—"}</td>
                <td className={`px-2 py-1.5 text-right tabular-nums ${(r.delay ?? 0) > 0 ? "text-rose-600 font-semibold" : ""}`}>
                  {r.delay ?? 0}d
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TimelineList({ events, loading }: { events: TimelineEvent[]; loading: boolean }) {
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!events.length) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
        No mails, messages, or flag changes recorded yet. Anything you dispatch above appears here.
      </div>
    );
  }
  return (
    <ol className="relative space-y-3 pl-5 before:absolute before:left-2 before:top-1 before:bottom-1 before:w-px before:bg-border/70">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className={`absolute -left-[13px] top-1.5 flex h-3 w-3 items-center justify-center rounded-full border-2 border-background ${
            e.kind === "alert_sent" ? "bg-amber-500"
            : e.kind === "alert_reply" ? "bg-sky-500"
            : e.kind === "alert_status" ? "bg-emerald-500"
            : "bg-muted-foreground"
          }`} aria-hidden />
          <div className="text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {e.kind === "alert_sent" && <Mail className="h-3.5 w-3.5 text-amber-500" aria-hidden />}
            {e.kind === "alert_reply" && <MessageCircle className="h-3.5 w-3.5 text-sky-500" aria-hidden />}
            {e.kind === "alert_status" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />}
            <span className="break-words">{e.title}</span>
            {e.severity && <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px] uppercase">{e.severity}</Badge>}
            {e.status && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{e.status}</Badge>}
          </div>
          {(e.actor.name || e.actor.email) && (
            <div className="text-[11px] text-muted-foreground">
              by <b>{e.actor.name || e.actor.email}</b>
            </div>
          )}
          {e.body && (
            <div className="mt-1 whitespace-pre-wrap rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-foreground/90">
              {e.body}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

// ── recommendation engine (rule-based, cites data)
function deriveRecommendations(data: DetailPayload | null, rows: DetailContextRow[]): string[] {
  if (!data) return [];
  const out: string[] = [];
  if (data.kind === "row" && data.row) {
    const tat = Number(data.row["TAT"] ?? 0) || 0;
    const taken = Number(data.row["Days Taken"] ?? 0) || 0;
    const delay = Math.max(0, taken - tat);
    if (delay > 30) out.push(`This activity is ${delay}d past its ${tat}d TAT — escalate to the reporting manager and set a hard recovery date within 3 business days.`);
    else if (delay > 0) out.push(`Slippage of ${delay}d against a ${tat}d TAT — request a same-day blocker list and next-checkpoint date.`);
    else if (taken > 0) out.push(`Activity is inside TAT (${taken}/${tat}d). Confirm remaining steps and lock the completion date.`);
    if ((data.person ?? "") && rows.length > 3) {
      const same = rows.filter(r => (r.person ?? "").toLowerCase() === (data.person ?? "").toLowerCase());
      const overdue = same.filter(r => (r.delay ?? 0) > 0).length;
      if (overdue >= 3) out.push(`${data.person} owns ${overdue} other delayed items — bundle a single check-in call instead of separate escalations.`);
    }
  } else if (rows.length) {
    const delayed = rows.filter(r => (r.delay ?? 0) > 0 && !/complete|done/i.test(r.status ?? ""));
    const worst = [...delayed].sort((a, b) => (b.delay ?? 0) - (a.delay ?? 0))[0];
    if (worst) out.push(`Start with the worst offender: "${worst.activity}" (${worst.delay}d late${worst.person ? `, ${worst.person}` : ""}).`);
    const totalDelay = delayed.reduce((s, r) => s + (r.delay ?? 0), 0);
    if (delayed.length >= 3) out.push(`${delayed.length} items are late by a combined ${totalDelay}d — request one consolidated recovery plan rather than per-item nudges.`);
    if (data.stage) {
      const stalled = rows.filter(r => (r.taken ?? 0) === 0 && /(not started|pending|planned)/i.test(r.status ?? ""));
      if (stalled.length >= 2) out.push(`${stalled.length} activities in ${data.stage} haven't started — confirm predecessors and unblock inputs first.`);
    }
  }
  return out.slice(0, 6);
}

function defaultBody(data: DetailPayload | null, activity: string, name: string) {
  const lines = [
    `Hi${name ? " " + name : ""},`,
    "",
    data?.detail ?? "",
    "",
    `Activity: ${activity}`,
    data?.stage ? `Stage: ${data.stage}` : "",
    data?.projectLabel ? `Project: ${data.projectLabel}` : "",
    "",
    "Please confirm a recovery date and any blockers. Reply to this alert directly.",
  ].filter(Boolean);
  return lines.join("\n");
}

function extractJson(text: string): { subject?: string; body?: string } | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function rankRows(rows: DetailContextRow[], q: string): DetailContextRow[] {
  const t = q.toLowerCase();
  const toks = t.split(/\s+/).filter(w => w.length > 2);
  const scored = rows.map(r => {
    const hay = `${r.activity} ${r.person ?? ""} ${r.stage ?? ""} ${r.status ?? ""}`.toLowerCase();
    let s = 0;
    for (const w of toks) if (hay.includes(w)) s += 1;
    if (/overdue|late|delay/.test(t) && (r.delay ?? 0) > 0) s += 1.5;
    if (/blocked|pending|not started/.test(t) && /(pending|not started|blocked)/i.test(r.status ?? "")) s += 1.5;
    return { r, s };
  });
  scored.sort((a, b) => b.s - a.s || (b.r.delay ?? 0) - (a.r.delay ?? 0));
  return scored.filter(x => x.s > 0).map(x => x.r);
}

function suggestedPrompts(data: DetailPayload): string[] {
  const list: string[] = [];
  if (data.person) list.push(`What is ${data.person} delayed on?`, `How many items has ${data.person} completed?`);
  if (data.stage) list.push(`Which activities in ${data.stage} are at risk?`);
  list.push("What should we escalate first?", "Summarize the current status.");
  return list.slice(0, 4);
}
