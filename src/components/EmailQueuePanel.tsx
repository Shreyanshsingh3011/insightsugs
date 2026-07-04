import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getEmailQueueStatus,
  resendAgentDraftEmail,
  bulkResendAgentDraftEmails,
  getDraftResendHistory,
  type EmailLogRow,
} from "@/lib/email-ops.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  Mail, RefreshCw, Search, Send, Loader2, X, Download, History, ChevronDown,
} from "lucide-react";

type StatusFilter = "all" | "sent" | "pending" | "failed" | "suppressed" | "dlq" | "bounced" | "complained";

function statusTone(s: string): string {
  if (s === "sent") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
  if (s === "pending") return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  if (s === "suppressed") return "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

const FAIL_STATES = new Set(["failed", "dlq", "bounced", "complained", "suppressed"]);
const PAGE_SIZE = 25;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: EmailLogRow[]): string {
  const headers = ["created_at", "status", "recipient_email", "template_name", "message_id", "draft_id", "error_message"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape((r as any)[h])).join(","));
  }
  return lines.join("\n");
}

export function EmailQueuePanel() {
  const fetchStatus = useServerFn(getEmailQueueStatus);
  const resendFn = useServerFn(resendAgentDraftEmail);
  const bulkResendFn = useServerFn(bulkResendAgentDraftEmails);
  const historyFn = useServerFn(getDraftResendHistory);
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
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [historyDraftId, setHistoryDraftId] = useState<string | null>(null);

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

  const bulkResend = useMutation({
    mutationFn: (ids: string[]) => bulkResendFn({ data: { draftIds: ids } }) as Promise<any>,
    onSuccess: (res) => {
      if (res.okCount > 0) toast.success(`Requeued ${res.okCount} draft${res.okCount === 1 ? "" : "s"}.`);
      if (res.failCount > 0) toast.error(`${res.failCount} failed to requeue.`);
      setSelectedDrafts(new Set());
      qc.invalidateQueries({ queryKey: ["email-queue-status"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Bulk resend failed"),
  });

  const historyQuery = useQuery({
    queryKey: ["draft-resend-history", historyDraftId],
    queryFn: () => historyFn({ data: { draftId: historyDraftId! } }) as any,
    enabled: !!historyDraftId,
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

  const visible = filtered.slice(0, visibleCount);
  const selectableIds = useMemo(
    () => visible.filter((r) => r.draft_id && FAIL_STATES.has(r.status)).map((r) => r.draft_id as string),
    [visible],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedDrafts.has(id));

  if (data && !data.isAdmin) return null;

  const hasFilters = search || messageId || draftId || status !== "all";

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `email-send-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const toggleDraft = (id: string) =>
    setSelectedDrafts((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleAll = () =>
    setSelectedDrafts((s) => {
      if (allSelected) {
        const n = new Set(s);
        selectableIds.forEach((id) => n.delete(id));
        return n;
      }
      const n = new Set(s);
      selectableIds.forEach((id) => n.add(id));
      return n;
    });

  return (
    <>
    <Card>
      <CardHeader className="flex flex-col gap-2 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <Mail className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">Email queue &amp; delivery</span>
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={exportCsv} disabled={!data || filtered.length === 0}>
            <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Export CSV
          </Button>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </Button>
        </div>
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
              onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Input
            placeholder="message_id contains…"
            value={messageId}
            onChange={(e) => { setMessageId(e.target.value); setVisibleCount(PAGE_SIZE); }}
            className="h-8 text-xs font-mono"
          />
          <Input
            placeholder="draft id contains…"
            value={draftId}
            onChange={(e) => { setDraftId(e.target.value); setVisibleCount(PAGE_SIZE); }}
            className="h-8 text-xs font-mono"
          />
          <Select value={status} onValueChange={(v) => { setStatus(v as StatusFilter); setVisibleCount(PAGE_SIZE); }}>
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
                setSearch(""); setMessageId(""); setDraftId(""); setStatus("all"); setVisibleCount(PAGE_SIZE);
              }}
            >
              <X className="mr-1 h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {/* Bulk actions bar */}
        {selectedDrafts.size > 0 && (
          <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs">
            <span>{selectedDrafts.size} draft{selectedDrafts.size === 1 ? "" : "s"} selected</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedDrafts(new Set())}>
                Clear
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={bulkResend.isPending}
                onClick={() => bulkResend.mutate(Array.from(selectedDrafts))}
              >
                {bulkResend.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Send className="mr-1 h-3 w-3" />
                )}
                Resend {selectedDrafts.size}
              </Button>
            </div>
          </div>
        )}

        {/* Log */}
        <div className="rounded-md border">
          <div className="hidden md:grid grid-cols-[24px_minmax(0,1.4fr)_120px_120px_auto] gap-2 border-b bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <div>
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                disabled={selectableIds.length === 0}
                aria-label="Select all failed/suppressed"
              />
            </div>
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
          {visible.map((r) => {
            const canResend = !!r.draft_id && FAIL_STATES.has(r.status);
            const isResending = resendingId === r.draft_id;
            const isSelected = r.draft_id ? selectedDrafts.has(r.draft_id) : false;
            return (
              <div
                key={r.id}
                className="flex flex-col gap-2 border-t px-3 py-2 text-xs md:grid md:grid-cols-[24px_minmax(0,1.4fr)_120px_120px_auto] md:items-center md:gap-2 md:py-1.5"
              >
                {/* Mobile top row: status + time + checkbox */}
                <div className="flex items-center gap-2 md:contents">
                  <div className="shrink-0 md:block">
                    {canResend && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleDraft(r.draft_id!)}
                        aria-label="Select for bulk resend"
                      />
                    )}
                  </div>
                  <div className="flex-1 md:hidden" />
                  <Badge variant="outline" className={`${statusTone(r.status)} md:hidden`}>{r.status}</Badge>
                  <div className="tabular-nums text-muted-foreground md:hidden">
                    {new Date(r.created_at).toLocaleTimeString()}
                  </div>
                </div>

                <div className="min-w-0">
                  <div className="truncate">
                    <span className="font-medium">{r.recipient_email ?? "—"}</span>
                    <span className="text-muted-foreground"> · {r.template_name ?? "—"}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                    {r.message_id && <span className="truncate" title={r.message_id}>msg:{r.message_id.slice(0, 12)}…</span>}
                    {r.draft_id && <span className="truncate" title={r.draft_id}>draft:{r.draft_id.slice(0, 8)}…</span>}
                  </div>
                  {r.error_message && (
                    <div className="mt-0.5 truncate text-[10px] text-destructive" title={r.error_message}>
                      {r.error_message}
                    </div>
                  )}
                </div>

                <div className="hidden md:block">
                  <Badge variant="outline" className={statusTone(r.status)}>{r.status}</Badge>
                </div>
                <div className="hidden tabular-nums text-muted-foreground md:block">
                  {new Date(r.created_at).toLocaleTimeString()}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-1">
                  {r.draft_id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-xs"
                      aria-label="View resend history"
                      title="View resend history"
                      onClick={() => setHistoryDraftId(r.draft_id!)}
                    >
                      <History className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  )}
                  {canResend && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 px-2 text-xs"
                      disabled={resend.isPending && isResending}
                      onClick={() => resend.mutate(r.draft_id!)}
                    >
                      {resend.isPending && isResending ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden />
                      ) : (
                        <Send className="mr-1 h-3 w-3" aria-hidden />
                      )}
                      Resend
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {filtered.length > visible.length && (
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Showing {visible.length} of {filtered.length} matches</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              <ChevronDown className="mr-1 h-3 w-3" /> Load {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
            </Button>
          </div>
        )}
      </CardContent>
    </Card>

    {/* Resend history drawer */}
    <Sheet open={!!historyDraftId} onOpenChange={(o) => !o && setHistoryDraftId(null)}>
      <SheetContent className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" /> Resend history
          </SheetTitle>
          <SheetDescription className="font-mono text-[10px]">
            draft: {historyDraftId}
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-2">
          {historyQuery.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
            </div>
          )}
          {historyQuery.data && historyQuery.data.rows.length === 0 && (
            <p className="text-xs text-muted-foreground">No send log entries found for this draft.</p>
          )}
          {historyQuery.data?.rows.map((row: EmailLogRow) => (
            <div key={row.id} className="rounded-md border p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" className={statusTone(row.status)}>{row.status}</Badge>
                <span className="tabular-nums text-muted-foreground">
                  {new Date(row.created_at).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground break-all">
                {row.message_id}
              </div>
              {row.error_message && (
                <div className="mt-1 text-[10px] text-destructive">{row.error_message}</div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
    </>
  );
}
