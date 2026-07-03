import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getEmailQueueStatus, resendAgentDraftEmail } from "@/lib/email-ops.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Mail, RefreshCw, Search, Send, Loader2, X } from "lucide-react";

type StatusFilter = "all" | "sent" | "pending" | "failed" | "suppressed" | "dlq" | "bounced" | "complained";

function statusTone(s: string): string {
  if (s === "sent") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  if (s === "pending") return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  if (s === "suppressed") return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

const FAIL_STATES = new Set(["failed", "dlq", "bounced", "complained", "suppressed"]);

export function EmailQueuePanel() {
  const fetchStatus = useServerFn(getEmailQueueStatus);
  const resendFn = useServerFn(resendAgentDraftEmail);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["email-queue-status"],
    queryFn: () => fetchStatus({ data: undefined as any }) as any,
    refetchInterval: 15_000,
  });
  const data = q.data as Awaited<ReturnType<typeof getEmailQueueStatus>> | undefined;

  const [search, setSearch] = useState("");
  const [messageId, setMessageId] = useState("");
  const [draftId, setDraftId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [resendingId, setResendingId] = useState<string | null>(null);

  const resend = useMutation({
    mutationFn: (id: string) => resendFn({ data: { draftId: id } }) as Promise<any>,
    onMutate: (id) => setResendingId(id),
    onSettled: () => setResendingId(null),
    onSuccess: (res) => {
      if (res.ok) toast.success("Resent — new message queued.");
      else toast.error(`Resend failed: ${res.reason}`);
      qc.invalidateQueries({ queryKey: ["email-queue-status"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Resend failed"),
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const s = search.trim().toLowerCase();
    const mid = messageId.trim().toLowerCase();
    const did = draftId.trim().toLowerCase();
    return data.recent.filter((r) => {
      if (status !== "all" && r.status !== status) return false;
      if (mid && !(r.message_id ?? "").toLowerCase().includes(mid)) return false;
      if (did && !(r.draft_id ?? "").toLowerCase().includes(did)) return false;
      if (s) {
        const hay = `${r.recipient_email ?? ""} ${r.template_name ?? ""} ${r.error_message ?? ""}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [data, search, messageId, draftId, status]);

  if (data && !data.isAdmin) return null;

  const hasFilters = search || messageId || draftId || status !== "all";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" /> Email queue &amp; delivery
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          Refresh now
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Drafts snapshot */}
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge variant="outline">Pending drafts: {data?.drafts.pending ?? 0}</Badge>
          <Badge variant="outline">Sent: {data?.drafts.sent ?? 0}</Badge>
          <Badge variant="outline">Snoozed: {data?.drafts.snoozed ?? 0}</Badge>
          <Badge variant="outline">Dismissed: {data?.drafts.dismissed ?? 0}</Badge>
          <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" variant="outline">
            Queued emails: {data?.drafts.queued_email ?? 0}
          </Badge>
          {data && data.drafts.pending_setup > 0 && (
            <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300" variant="outline">
              Pending setup (legacy): {data.drafts.pending_setup}
            </Badge>
          )}
        </div>

        {/* Filters */}
        <div className="grid gap-2 md:grid-cols-[1.4fr_1fr_1fr_140px_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search recipient, template, error…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Input
            placeholder="message_id contains…"
            value={messageId}
            onChange={(e) => setMessageId(e.target.value)}
            className="h-8 text-xs font-mono"
          />
          <Input
            placeholder="draft id contains…"
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            className="h-8 text-xs font-mono"
          />
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="dlq">DLQ</SelectItem>
              <SelectItem value="suppressed">Suppressed</SelectItem>
              <SelectItem value="bounced">Bounced</SelectItem>
              <SelectItem value="complained">Complained</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => {
                setSearch(""); setMessageId(""); setDraftId(""); setStatus("all");
              }}
            >
              <X className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {/* Log */}
        <div className="rounded-md border">
          <div className="grid grid-cols-[1.4fr_120px_120px_auto] gap-2 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <div>Recipient · template · IDs</div>
            <div>Status</div>
            <div>When</div>
            <div className="text-right">Actions</div>
          </div>
          {!data && <div className="p-3 text-xs text-muted-foreground">Loading…</div>}
          {data && filtered.length === 0 && (
            <div className="p-3 text-xs text-muted-foreground">
              {data.recent.length === 0
                ? "No email sends logged yet. Approve a draft with an email recipient to trigger the first send."
                : "No entries match the current filters."}
            </div>
          )}
          {filtered.slice(0, 25).map((r) => {
            const canResend = !!r.draft_id && FAIL_STATES.has(r.status);
            const isResending = resendingId === r.draft_id;
            return (
              <div
                key={r.id}
                className="grid grid-cols-[1.4fr_120px_120px_auto] items-center gap-2 border-t px-3 py-1.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate">
                    <span className="font-medium">{r.recipient_email ?? "—"}</span>
                    <span className="text-muted-foreground"> · {r.template_name ?? "—"}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.message_id && <span title="message_id">msg:{r.message_id.slice(0, 8)}…</span>}
                    {r.draft_id && <span title="agent_drafts.id">draft:{r.draft_id.slice(0, 8)}…</span>}
                  </div>
                  {r.error_message && (
                    <div className="mt-0.5 truncate text-[10px] text-destructive" title={r.error_message}>
                      {r.error_message}
                    </div>
                  )}
                </div>
                <div>
                  <Badge variant="outline" className={statusTone(r.status)}>{r.status}</Badge>
                </div>
                <div className="tabular-nums text-muted-foreground">
                  {new Date(r.created_at).toLocaleTimeString()}
                </div>
                <div className="text-right">
                  {canResend && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={resend.isPending && isResending}
                      onClick={() => resend.mutate(r.draft_id!)}
                    >
                      {resend.isPending && isResending ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="mr-1 h-3 w-3" />
                      )}
                      Resend
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {data && filtered.length > 25 && (
          <div className="text-[10px] text-muted-foreground">
            Showing 25 of {filtered.length} matches. Narrow the filters to see more.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
