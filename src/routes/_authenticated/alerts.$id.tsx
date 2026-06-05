import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  ArrowLeft, Flag, AlertTriangle, Clock, User, Building2, Mail, Phone,
  FileSearch, TrendingUp, Lock, Send, CheckCircle2, MessageSquare, ShieldCheck,
} from "lucide-react";
import { fetchDashboard, type DashboardData, type FlagEntry } from "@/lib/dashboard-data";
import { buildDashboardFromSheets } from "@/lib/dashboard.functions";
import { sendAlert, getAlertByFlag, replyToAlert, resolveAlert } from "@/lib/alerts.functions";
import { useIsAdmin } from "@/hooks/useSession";

const SHEETS_KEY = "dashboard.selectedSheets.v1";

export const Route = createFileRoute("/_authenticated/alerts/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Alert ${params.id} — DelayLens` },
      { name: "description", content: "Full alert details, root cause and ownership." },
    ],
  }),
  component: AlertDetails,
});

function sevColor(sev?: string | null) {
  switch (sev) {
    case "Critical": return "bg-destructive/15 text-destructive border-destructive/30";
    case "High": return "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30";
    case "Medium": return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30";
    default: return "bg-muted text-muted-foreground border-border";
  }
}

function statusColor(s?: string | null) {
  switch (s) {
    case "resolved": return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
    case "acknowledged": return "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30";
    default: return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  }
}

function AlertDetails() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();

  const [selectedSheetIds, setSelectedSheetIds] = useState<string[]>([]);
  useEffect(() => {
    try { const s = localStorage.getItem(SHEETS_KEY); if (s) setSelectedSheetIds(JSON.parse(s)); } catch {}
  }, []);

  const buildFn = useServerFn(buildDashboardFromSheets);
  const sendFn = useServerFn(sendAlert);
  const getAlertFn = useServerFn(getAlertByFlag);
  const replyFn = useServerFn(replyToAlert);
  const resolveFn = useServerFn(resolveAlert);

  const dynamic = selectedSheetIds.length > 0;
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: dynamic ? ["alerts", "dynamic", ...selectedSheetIds] : ["alerts", "static"],
    queryFn: () => dynamic ? buildFn({ data: { sheetIds: selectedSheetIds } }) : fetchDashboard(),
  });

  const flag: FlagEntry | undefined = useMemo(() => data?.flags?.find((f) => f.id === id), [data, id]);

  const alertQ = useQuery({
    queryKey: ["alert", id],
    queryFn: () => getAlertFn({ data: { flagId: id } }),
  });

  const dispatched = !!alertQ.data?.alert;
  const alertRow = alertQ.data?.alert;
  const recipients = alertQ.data?.recipients ?? [];
  const messages = alertQ.data?.messages ?? [];
  const uniqueRecipients = useMemo(() => {
    const seen = new Set<string>();
    return recipients.filter((r: any) => {
      if (seen.has(r.email)) return false;
      seen.add(r.email);
      return true;
    });
  }, [recipients]);

  const sendMut = useMutation({
    mutationFn: async () => {
      if (!flag) throw new Error("Flag not loaded");
      const overrunPct = flag.tat && flag.days_taken ? Math.round(((flag.days_taken - flag.tat) / flag.tat) * 100) : null;
      const overrun = flag.tat && flag.days_taken ? Math.max(0, flag.days_taken - flag.tat) : (flag.overdue_days ?? 0);
      const rootCause =
        (flag.days_taken ?? 0) === 0 && (flag.overdue_days ?? 0) === 0
          ? `Activity not yet started — ${flag.stage ?? "stage"} pending action.`
          : overrunPct !== null
            ? `Took ${flag.days_taken}d vs ${flag.tat}d TAT — ${overrunPct}% overrun (${overrun}d late).`
            : `${overrun}d overdue beyond planned TAT.`;
      return sendFn({
        data: {
          flag: {
            id: flag.id,
            activity: flag.activity,
            stage: flag.stage ?? null,
            severity: flag.severity ?? null,
            source: flag.stage ?? null,
            root_cause: rootCause,
            reason: flag.reason_text?.trim() || flag.reason || null,
            responsible_email: flag.flagged_to?.email ?? null,
            responsible_name: flag.flagged_to?.person ?? null,
          },
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`Alert dispatched to ${r.recipientCount} recipient${r.recipientCount === 1 ? "" : "s"}.`);
      qc.invalidateQueries({ queryKey: ["alert", id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to send alert"),
  });

  const [reply, setReply] = useState("");
  const replyMut = useMutation({
    mutationFn: () => replyFn({ data: { alertId: alertRow!.id, body: reply.trim() } }),
    onSuccess: () => {
      setReply("");
      qc.invalidateQueries({ queryKey: ["alert", id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to post reply"),
  });

  const resolveMut = useMutation({
    mutationFn: () => resolveFn({ data: { alertId: alertRow!.id } }),
    onSuccess: () => {
      toast.success("Alert marked resolved");
      qc.invalidateQueries({ queryKey: ["alert", id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to resolve"),
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/alerts" })} className="-ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to alerts
        </Button>
        <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">
          View dashboard
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading alert…</p>}

      {!isLoading && !flag && (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-muted-foreground">
          <AlertTriangle className="h-7 w-7" />
          <p className="text-sm">Alert <span className="font-mono">{id}</span> not found in the current dataset.</p>
          <Button size="sm" variant="outline" onClick={() => navigate({ to: "/alerts" })}>Back to list</Button>
        </Card>
      )}

      {flag && (() => {
        const owner = flag.flagged_to?.person;
        const email = flag.flagged_to?.email;
        const phone = flag.flagged_to?.phone;
        const reason = flag.reason_text?.trim() || flag.reason || "Not specified";
        const overrun = flag.tat && flag.days_taken ? Math.max(0, flag.days_taken - flag.tat) : (flag.overdue_days ?? 0);
        const overrunPct = flag.tat && flag.days_taken ? Math.round(((flag.days_taken - flag.tat) / flag.tat) * 100) : null;
        const rootCause =
          (flag.days_taken ?? 0) === 0 && (flag.overdue_days ?? 0) === 0
            ? `Activity not yet started — ${flag.stage ?? "stage"} pending action from ${owner ?? "owner"}.`
            : overrunPct !== null
              ? `Took ${flag.days_taken}d vs ${flag.tat}d TAT — ${overrunPct}% overrun (${overrun}d late).`
              : `${overrun}d overdue beyond planned TAT.`;

        return (
          <div className="space-y-5">
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Flag className="h-4 w-4 text-destructive" />
                    <span className="font-mono text-xs text-muted-foreground">{flag.id}</span>
                    <span className={`rounded-md border px-2 py-0.5 text-xs ${sevColor(flag.severity)}`}>
                      {flag.severity ?? "—"}
                    </span>
                    <span className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                      {flag.status ?? "—"}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <Lock className="h-3 w-3" /> Read-only record
                    </span>
                    {dispatched && (
                      <span className={`rounded-md border px-2 py-0.5 text-xs ${statusColor(alertRow?.status)}`}>
                        {alertRow?.status}
                      </span>
                    )}
                  </div>
                  <h1 className="mt-2 text-lg font-semibold tracking-tight">{flag.activity}</h1>
                  <p className="text-xs text-muted-foreground">
                    Stage: {flag.stage ?? "—"} · Type: {flag.type ?? "delay"} · Escalation L{flag.escalation_level ?? 0}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Overdue</p>
                  <p className="text-2xl font-semibold text-destructive">{flag.overdue_days ?? 0}d</p>
                </div>
              </div>

              {isAdmin && (
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-4">
                  {!dispatched ? (
                    <Button size="sm" onClick={() => sendMut.mutate()} disabled={sendMut.isPending}>
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                      {sendMut.isPending ? "Sending…" : "Send Alert"}
                    </Button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                      Dispatched · {uniqueRecipients.length} recipient{uniqueRecipients.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {dispatched && alertRow?.status !== "resolved" && (
                    <Button size="sm" variant="outline" onClick={() => resolveMut.mutate()} disabled={resolveMut.isPending}>
                      <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                      {resolveMut.isPending ? "Resolving…" : "Mark resolved"}
                    </Button>
                  )}
                </div>
              )}
            </Card>

            <Card className="border-destructive/30 bg-destructive/5 p-5">
              <p className="text-[10px] uppercase tracking-wider text-destructive">Root cause</p>
              <p className="mt-1 text-sm">{rootCause}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Reason flagged:</span> {reason}
              </p>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <Card className="p-5">
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Ownership</p>
                <div className="space-y-2 text-sm">
                  <Row icon={<User className="h-3.5 w-3.5" />} label="Responsible" value={owner ?? "—"} />
                  <Row icon={<Mail className="h-3.5 w-3.5" />} label="Email" value={email ?? "—"} />
                  <Row icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={phone ?? "—"} />
                  <Row icon={<Building2 className="h-3.5 w-3.5" />} label="Stage / Source" value={flag.stage ?? "—"} />
                </div>
              </Card>

              <Card className="p-5">
                <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Timing</p>
                <div className="space-y-2 text-sm">
                  <Row icon={<Clock className="h-3.5 w-3.5" />} label="Planned TAT" value={flag.tat != null ? `${flag.tat} days` : "—"} />
                  <Row icon={<Clock className="h-3.5 w-3.5" />} label="Actual taken" value={flag.days_taken != null ? `${flag.days_taken} days` : "Not started"} />
                  <Row icon={<TrendingUp className="h-3.5 w-3.5" />} label="Overrun" value={overrunPct !== null ? `${overrunPct}% (${overrun}d)` : `${overrun}d`} />
                  <Row icon={<AlertTriangle className="h-3.5 w-3.5" />} label="Criticality" value={flag.criticality ?? "—"} />
                </div>
              </Card>
            </div>

            {dispatched && (
              <Card className="p-5">
                <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" /> Recipients ({uniqueRecipients.length})
                </p>
                <div className="space-y-1.5 text-sm">
                  {uniqueRecipients.map((r: any) => {
                    const channels = recipients.filter((x: any) => x.email === r.email).map((x: any) => x.channel);
                    return (
                      <div key={r.email} className="flex items-center justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
                        <div>
                          <p className="font-medium">{r.name ?? r.email.split("@")[0]}</p>
                          <p className="text-xs text-muted-foreground">{r.email}</p>
                        </div>
                        <div className="flex gap-1">
                          {channels.includes("inapp") && (
                            <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
                              In-app delivered
                            </span>
                          )}
                          {channels.includes("email") && (
                            <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                              Email pending
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!uniqueRecipients.length && <p className="text-xs text-muted-foreground">No recipients resolved.</p>}
                </div>
              </Card>
            )}

            {dispatched && (
              <Card className="p-5">
                <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" /> Communication
                </p>
                <div className="space-y-3">
                  {messages.length === 0 && <p className="text-xs text-muted-foreground">No replies yet.</p>}
                  {messages.map((m: any) => (
                    <div key={m.id} className="rounded-md border border-border bg-muted/30 p-3">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{m.author?.full_name ?? m.author?.email ?? "User"}</span>
                        <span>{new Date(m.created_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm">{m.body}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-4 space-y-2">
                  <Textarea
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    placeholder="Write a reply or resolution note…"
                    rows={3}
                    maxLength={4000}
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => replyMut.mutate()} disabled={replyMut.isPending || !reply.trim()}>
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                      {replyMut.isPending ? "Posting…" : "Post reply"}
                    </Button>
                  </div>
                </div>
              </Card>
            )}

            <Card className="p-5">
              <p className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <FileSearch className="h-3.5 w-3.5" /> Source context
              </p>
              <p className="text-sm text-muted-foreground">
                Sourced from {dynamic ? `${selectedSheetIds.length} selected sheet${selectedSheetIds.length === 1 ? "" : "s"}` : "the demo dataset"}.
                Stage label: <span className="text-foreground">{flag.stage ?? "sheet"}</span>.
              </p>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 pb-2 last:border-0 last:pb-0">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}
