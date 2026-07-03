import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft, Mail, Send, User as UserIcon, Layers, AlertTriangle,
  ExternalLink, MessageSquare, History, CheckCircle2, MessageCircle,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { decodeDetailPayload, type DetailPayload } from "@/lib/agent-detail-payload";
import { sendAlert } from "@/lib/alerts.functions";
import { getSourceTimeline, type TimelineEvent } from "@/lib/source-timeline.functions";
import { fetchMyRoles } from "@/lib/route-guards";

export const Route = createFileRoute("/_authenticated/agent/detail/$payload")({
  head: () => ({ meta: [{ title: "Action detail — DelayLens" }] }),
  beforeLoad: async () => {
    const roles = await fetchMyRoles();
    if (roles.length === 0) {
      // Unverified account — bounce to home instead of exposing action data.
      throw redirect({ to: "/" });
    }
  },
  component: DetailPage,
});

const TONE: Record<string, string> = {
  high: "text-rose-700 bg-rose-500/10 border-rose-500/30",
  med: "text-amber-800 bg-amber-500/10 border-amber-500/30",
  low: "text-slate-700 bg-slate-500/10 border-slate-500/30",
  ok: "text-emerald-700 bg-emerald-500/10 border-emerald-500/30",
};

function DetailPage() {
  const { payload: encoded } = Route.useParams();
  const data = useMemo<DetailPayload | null>(() => {
    try { return decodeDetailPayload(encoded); } catch { return null; }
  }, [encoded]);

  const sendFn = useServerFn(sendAlert);
  const timelineFn = useServerFn(getSourceTimeline);
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

  const [subject, setSubject] = useState(`Action needed: ${activityTitle}`);
  const [body, setBody] = useState(() => {
    const lines = [
      `Hi${responsibleName ? " " + responsibleName : ""},`,
      "",
      data?.detail ?? "",
      "",
      `Activity: ${activityTitle}`,
      data?.stage ? `Stage: ${data.stage}` : "",
      data?.projectLabel ? `Project: ${data.projectLabel}` : "",
      "",
      "Please confirm a recovery date and blockers. Reply to this alert directly.",
    ].filter(Boolean);
    return lines.join("\n");
  });

  const alertMut = useMutation({
    mutationFn: async (channel: "email" | "message") => {
      const flag = {
        id: `agent-${(data?.source ?? "action").toLowerCase()}-${Date.now()}`,
        activity: activityTitle.slice(0, 500),
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
    queryFn: () => timelineFn({ data: { activity: activityTitle, stage: data?.stage ?? null } }),
    enabled: !!activityTitle,
    refetchInterval: 30_000,
  });

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-4">
        <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <Card className="p-6 text-sm text-muted-foreground">This action link is malformed or expired.</Card>
      </div>
    );
  }

  const rowEntries = data.row ? Object.entries(data.row).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "") : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link to="/agent" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </Link>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {data.projectLabel && <Badge variant="outline">{data.projectLabel}</Badge>}
          {data.source && <Badge variant="secondary">{data.source}</Badge>}
        </div>
      </div>

      {/* HEADER */}
      <Card className={`border ${TONE[data.severity ?? "med"]}`}>
        <CardContent className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-5 w-5" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold uppercase tracking-widest opacity-70">{data.source ?? "Action"}</div>
              <h1 className="mt-0.5 text-xl font-semibold leading-tight">{data.title}</h1>
              {data.detail && <p className="mt-2 text-sm opacity-90">{data.detail}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {data.person && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-background/60 px-2 py-1">
                    <UserIcon className="h-3 w-3" /> {data.person}
                  </span>
                )}
                {data.stage && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-background/60 px-2 py-1">
                    <Layers className="h-3 w-3" /> {data.stage}
                  </span>
                )}
                {responsibleEmail && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-current/20 bg-background/60 px-2 py-1">
                    <Mail className="h-3 w-3" /> {responsibleEmail}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* SOURCE ROW */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ExternalLink className="h-4 w-4" /> Source record
              <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                {rowEntries.length ? `${rowEntries.length} fields` : "aggregate action"}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rowEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This action was derived from aggregated metrics ({data.source}). Use the message panel to notify the owner.
              </p>
            ) : (
              <div className="divide-y divide-border/60 rounded-lg border border-border/60">
                {rowEntries.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(140px,32%)_1fr] gap-3 px-3 py-2 text-sm">
                    <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{k}</div>
                    <div className="whitespace-pre-wrap break-words">{String(v)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ACTION PANEL */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="h-4 w-4 text-primary" /> Take action
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</label>
              <Input value={responsibleEmail || "(no email on record — in-app message only)"} readOnly className="text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Subject</label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Message</label>
              <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} className="resize-y" />
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                onClick={() => alertMut.mutate("email")}
                disabled={alertMut.isPending || !responsibleEmail}
              >
                <Mail className="h-4 w-4" /> Send email
              </Button>
              <Button
                variant="outline"
                onClick={() => alertMut.mutate("message")}
                disabled={alertMut.isPending}
              >
                <Send className="h-4 w-4" /> Send in-app message
              </Button>
            </div>
            <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
              Delivered through the existing alerts pipeline. Recipients are matched from the source row and any linked
              project members. Replies show up in the Alerts inbox.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* TIMELINE */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-primary" /> Communication &amp; flag timeline
            {timelineQ.data && <Badge variant="secondary">{timelineQ.data.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <TimelineList events={timelineQ.data ?? []} loading={timelineQ.isLoading} />
        </CardContent>
      </Card>
    </div>
  );
}

function TimelineList({ events, loading }: { events: TimelineEvent[]; loading: boolean }) {
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (!events.length) {
    return (
      <div className="rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
        No mails, messages, or flag changes recorded for this source record yet. Any alert you dispatch above will show up
        here automatically.
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
          }`} />
          <div className="text-xs text-muted-foreground">{new Date(e.at).toLocaleString()}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-sm font-medium">
            {e.kind === "alert_sent" && <Mail className="h-3.5 w-3.5 text-amber-500" />}
            {e.kind === "alert_reply" && <MessageCircle className="h-3.5 w-3.5 text-sky-500" />}
            {e.kind === "alert_status" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
            {e.title}
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
