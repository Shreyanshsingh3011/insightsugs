import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getEmailQueueStatus } from "@/lib/email-ops.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Mail, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

function statusTone(s: string): string {
  if (s === "sent") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  if (s === "pending") return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  if (s === "suppressed") return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30"; // dlq / failed / bounced / complained
}

export function EmailQueuePanel() {
  const fetchStatus = useServerFn(getEmailQueueStatus);
  const q = useQuery({
    queryKey: ["email-queue-status"],
    queryFn: () => fetchStatus({ data: undefined as any }) as any,
    refetchInterval: 15_000,
  });
  const data = q.data as Awaited<ReturnType<typeof getEmailQueueStatus>> | undefined;

  if (data && !data.isAdmin) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" /> Email queue & delivery
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Drafts snapshot */}
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge variant="outline">Pending drafts: {data?.drafts.pending ?? 0}</Badge>
          <Badge variant="outline">Sent: {data?.drafts.sent ?? 0}</Badge>
          <Badge variant="outline">Snoozed: {data?.drafts.snoozed ?? 0}</Badge>
          <Badge variant="outline">Dismissed: {data?.drafts.dismissed ?? 0}</Badge>
          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" variant="outline">
            Queued emails: {data?.drafts.queued_email ?? 0}
          </Badge>
          {data && data.drafts.pending_setup > 0 && (
            <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" variant="outline">
              Pending setup (legacy): {data.drafts.pending_setup}
            </Badge>
          )}
        </div>

        {/* Recent log */}
        <div className="rounded-md border">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <div>Recipient · template</div>
            <div>Status</div>
            <div>When</div>
          </div>
          {!data && <div className="p-3 text-xs text-muted-foreground">Loading…</div>}
          {data && data.recent.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground">
              No email sends logged yet. Approve a draft with an email recipient to trigger the first send.
            </div>
          )}
          {data?.recent.slice(0, 8).map((r) => (
            <div
              key={r.id}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-t px-3 py-1.5 text-xs"
              title={r.error_message ?? ""}
            >
              <div className="min-w-0 truncate">
                <span className="font-medium">{r.recipient_email ?? "—"}</span>
                <span className="text-muted-foreground"> · {r.template_name ?? "—"}</span>
              </div>
              <Badge variant="outline" className={statusTone(r.status)}>
                {r.status}
              </Badge>
              <div className="text-muted-foreground tabular-nums">
                {new Date(r.created_at).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
