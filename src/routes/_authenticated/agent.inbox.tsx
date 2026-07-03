import { createFileRoute, useSearch, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listAgentDrafts,
  approveAgentDraft,
  dismissAgentDraft,
  snoozeAgentDraft,
  editAgentDraft,
  unsnoozeAgentDraft,
  type AgentDraft,
} from "@/lib/agent-inbox.functions";
import { runAgentWatchers } from "@/lib/agent-watchers.functions";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Inbox as InboxIcon,
  Check,
  Clock,
  X,
  Pencil,
  Send,
  RefreshCw,
  ChevronRight,
  ArrowLeft,
  Sparkles,
  Filter,
} from "lucide-react";

type SearchParams = {
  focus?: string;
  state?: "pending" | "approved" | "dismissed" | "snoozed" | "sent" | "failed";
  scope?: "mine" | "all";
};

export const Route = createFileRoute("/_authenticated/agent/inbox")({
  head: () => ({ meta: [{ title: "Agent Inbox — DelayLens" }] }),
  validateSearch: (raw: Record<string, unknown>): SearchParams => ({
    focus: typeof raw.focus === "string" ? raw.focus : undefined,
    state:
      raw.state === "pending" ||
      raw.state === "approved" ||
      raw.state === "dismissed" ||
      raw.state === "snoozed" ||
      raw.state === "sent" ||
      raw.state === "failed"
        ? raw.state
        : undefined,
    scope: raw.scope === "all" ? "all" : "mine",
  }),
  component: AgentInboxPage,
});

// ---------- helpers ----------

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function draftTypeLabel(t: string): string {
  const map: Record<string, string> = {
    nudge: "Nudge",
    escalation: "Escalation",
    root_cause_ask: "Root-cause ask",
    investigation: "Investigation",
    status_update: "Status update",
    digest: "Digest",
    custom: "Custom",
  };
  return map[t] ?? t;
}

function channelLabel(c: string): string {
  return (
    { email: "Email", direct_message: "In-app", slack: "Slack", sheet_writeback: "Sheet" }[c] ??
    c
  );
}

function stateTone(state: string) {
  switch (state) {
    case "pending":
      return "bg-amber-500/15 text-amber-700 border-amber-300 dark:text-amber-300";
    case "snoozed":
      return "bg-slate-500/15 text-slate-700 border-slate-300 dark:text-slate-300";
    case "sent":
      return "bg-emerald-500/15 text-emerald-700 border-emerald-300 dark:text-emerald-300";
    case "dismissed":
      return "bg-zinc-500/15 text-zinc-700 border-zinc-300 dark:text-zinc-300";
    case "failed":
      return "bg-rose-500/15 text-rose-700 border-rose-300 dark:text-rose-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function confidenceTone(v: number) {
  if (v >= 0.75) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

// ---------- page ----------

function AgentInboxPage() {
  const search = useSearch({ from: "/_authenticated/agent/inbox" });
  const qc = useQueryClient();
  const listFn = useServerFn(listAgentDrafts);
  const approveFn = useServerFn(approveAgentDraft);
  const dismissFn = useServerFn(dismissAgentDraft);
  const snoozeFn = useServerFn(snoozeAgentDraft);
  const editFn = useServerFn(editAgentDraft);
  const unsnoozeFn = useServerFn(unsnoozeAgentDraft);

  const [stateFilter, setStateFilter] = useState<SearchParams["state"] | "active">(
    search.state ?? "active",
  );
  const [scope, setScope] = useState<"mine" | "all">(search.scope ?? "mine");
  const [openId, setOpenId] = useState<string | null>(search.focus ?? null);

  const statesArg = useMemo(() => {
    if (stateFilter === "active") return ["pending", "snoozed"] as const;
    return [stateFilter] as const;
  }, [stateFilter]);

  const q = useQuery({
    queryKey: ["agent-drafts", statesArg, scope],
    queryFn: () => listFn({ data: { states: [...statesArg], scope, limit: 200 } }),
    staleTime: 15_000,
  });

  const drafts = q.data?.drafts ?? [];
  const isAdmin = !!q.data?.isAdmin;
  const activeDraft = drafts.find((d) => d.id === openId) ?? null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["agent-drafts"] });

  const approve = useMutation({
    mutationFn: (id: string) => approveFn({ data: { id } }),
    onSuccess: (r) => {
      const msg =
        r.delivery === "in_app"
          ? "Sent as in-app message."
          : r.delivery === "email_pending"
            ? "Approved — email delivery pending."
            : "Approved.";
      toast.success(msg);
      setOpenId(null);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const dismiss = useMutation({
    mutationFn: (v: { id: string; reason: string | null }) => dismissFn({ data: v }),
    onSuccess: () => {
      toast.success("Dismissed.");
      setOpenId(null);
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const snooze = useMutation({
    mutationFn: (id: string) => snoozeFn({ data: { id, hours: 24 } }),
    onSuccess: () => {
      toast.success("Snoozed 24h.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const unsnooze = useMutation({
    mutationFn: (id: string) => unsnoozeFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Restored to pending.");
      invalidate();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/agent"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <InboxIcon className="h-5 w-5" /> Agent Inbox
        </h1>
        <Badge variant="secondary" className="ml-1">
          {drafts.length}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <RunWatchersButton onDone={invalidate} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            <span className="ml-1.5">Refresh</span>
          </Button>
        </div>

      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
        <div className="flex items-center gap-1 pl-1 text-xs uppercase tracking-wide text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> State
        </div>
        {(
          [
            ["active", "Active"],
            ["pending", "Pending"],
            ["snoozed", "Snoozed"],
            ["sent", "Sent"],
            ["dismissed", "Dismissed"],
            ["failed", "Failed"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setStateFilter(k as SearchParams["state"] | "active")}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              stateFilter === k
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-accent"
            }`}
          >
            {label}
          </button>
        ))}
        {isAdmin && (
          <>
            <span className="mx-2 h-4 w-px bg-border" />
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Scope</div>
            {(["mine", "all"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setScope(k)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  scope === k
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground hover:bg-accent"
                }`}
              >
                {k === "mine" ? "Assigned to me" : "All"}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Empty / loading */}
      {q.isLoading ? (
        <div className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-muted/30" />
          ))}
        </div>
      ) : drafts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-base font-medium">Inbox is clear</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            The agent hasn't drafted any actions in this view. Open a card on the dashboard and
            use <span className="rounded bg-muted px-1">Draft an action</span> to seed one.
          </p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {drafts.map((d) => (
            <DraftRow
              key={d.id}
              draft={d}
              onOpen={() => setOpenId(d.id)}
              onSnooze={() => snooze.mutate(d.id)}
              onUnsnooze={() => unsnooze.mutate(d.id)}
            />
          ))}
        </ul>
      )}

      {/* Detail drawer */}
      <DraftDrawer
        draft={activeDraft}
        onClose={() => setOpenId(null)}
        onApprove={(id) => approve.mutate(id)}
        onDismiss={(id, reason) => dismiss.mutate({ id, reason })}
        onEdit={async (id, patch) => {
          await editFn({ data: { id, ...patch } });
          invalidate();
          toast.success("Draft updated.");
        }}
        busy={approve.isPending || dismiss.isPending}
      />
    </div>
  );
}

// ---------- Row ----------

function DraftRow({
  draft,
  onOpen,
  onSnooze,
  onUnsnooze,
}: {
  draft: AgentDraft;
  onOpen: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
}) {
  const recipientLabel = draft.recipient?.full_name || draft.recipient_email || "unassigned";
  return (
    <li>
      <div className="group flex items-start gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40 hover:bg-accent/40">
        <button
          onClick={onOpen}
          className="flex flex-1 items-start gap-3 text-left"
          aria-label={`Open draft: ${draft.title}`}
        >
          <div className="mt-0.5 hidden shrink-0 md:block">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {draftTypeLabel(draft.draft_type)}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {channelLabel(draft.channel)}
              </Badge>
              <Badge className={`text-[10px] border ${stateTone(draft.state)}`} variant="outline">
                {draft.state}
              </Badge>
              <span className={`text-[11px] font-medium ${confidenceTone(draft.confidence)}`}>
                {Math.round(draft.confidence * 100)}% confident
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {relTime(draft.created_at)}
              </span>
            </div>
            <div className="mt-1 truncate text-sm font-medium">{draft.title}</div>
            {draft.why && (
              <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                <span className="text-muted-foreground/80">Why:</span> {draft.why}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <span>
                To: <span className="text-foreground/80">{recipientLabel}</span>
              </span>
              <span>·</span>
              <span>
                Source: <span className="text-foreground/80">{draft.source_kind}</span>
              </span>
              {draft.snoozed_until && (
                <>
                  <span>·</span>
                  <span>
                    Until{" "}
                    <span className="text-foreground/80">
                      {new Date(draft.snoozed_until).toLocaleString()}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
        </button>

        {draft.state === "pending" && (
          <Button
            variant="ghost"
            size="icon"
            title="Snooze 24h"
            onClick={(e) => {
              e.stopPropagation();
              onSnooze();
            }}
            className="h-8 w-8"
          >
            <Clock className="h-4 w-4" />
          </Button>
        )}
        {draft.state === "snoozed" && (
          <Button
            variant="ghost"
            size="sm"
            title="Move to pending"
            onClick={(e) => {
              e.stopPropagation();
              onUnsnooze();
            }}
          >
            Unsnooze
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------- Drawer ----------

function DraftDrawer({
  draft,
  onClose,
  onApprove,
  onDismiss,
  onEdit,
  busy,
}: {
  draft: AgentDraft | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onDismiss: (id: string, reason: string | null) => void;
  onEdit: (id: string, patch: { subject?: string | null; body?: string; recipient_email?: string | null }) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipient, setRecipient] = useState("");
  const [dismissOpen, setDismissOpen] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [saving, setSaving] = useState(false);

  // reset edit buffer whenever a new draft opens
  useMemo(() => {
    if (draft) {
      setSubject(draft.subject ?? "");
      setBody(draft.body);
      setRecipient(draft.recipient_email ?? "");
      setEditing(false);
    }
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = !!draft;
  const isTerminal = draft && ["sent", "dismissed", "failed"].includes(draft.state);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-xl overflow-y-auto sm:max-w-xl"
      >
        {draft && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6 text-base leading-tight">{draft.title}</SheetTitle>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                  {draftTypeLabel(draft.draft_type)}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {channelLabel(draft.channel)}
                </Badge>
                <Badge className={`text-[10px] border ${stateTone(draft.state)}`} variant="outline">
                  {draft.state}
                </Badge>
                <span className={`text-[11px] font-medium ${confidenceTone(draft.confidence)}`}>
                  {Math.round(draft.confidence * 100)}% confident
                </span>
              </div>
            </SheetHeader>

            <div className="mt-5 space-y-4">
              {/* Why */}
              {draft.why && (
                <section className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Why the agent drafted this
                  </div>
                  <p className="mt-1 text-foreground">{draft.why}</p>
                </section>
              )}

              {/* Source deep-link */}
              <section className="rounded-md border border-border p-3 text-sm">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Source
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate text-foreground">
                    <span className="text-muted-foreground">{draft.source_kind}:</span>{" "}
                    {draft.source_key}
                  </div>
                  <SourceLink kind={draft.source_kind} keyStr={draft.source_key} />
                </div>
              </section>

              {/* Recipient / subject / body */}
              <section className="space-y-2 rounded-md border border-border p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Message
                </div>
                <div className="grid gap-2">
                  <label className="text-xs text-muted-foreground">To</label>
                  {editing ? (
                    <Input
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="recipient@example.com"
                    />
                  ) : (
                    <div className="text-sm">
                      {draft.recipient?.full_name && (
                        <span className="font-medium">{draft.recipient.full_name}</span>
                      )}
                      {draft.recipient?.full_name && draft.recipient_email && " · "}
                      <span className="text-muted-foreground">
                        {draft.recipient_email ?? draft.recipient?.email ?? "—"}
                      </span>
                    </div>
                  )}
                </div>
                <div className="grid gap-2">
                  <label className="text-xs text-muted-foreground">Subject</label>
                  {editing ? (
                    <Input
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Subject"
                    />
                  ) : (
                    <div className="text-sm">{draft.subject || <span className="text-muted-foreground">—</span>}</div>
                  )}
                </div>
                <div className="grid gap-2">
                  <label className="text-xs text-muted-foreground">Body</label>
                  {editing ? (
                    <Textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      rows={10}
                      className="font-mono text-xs"
                    />
                  ) : (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 text-xs text-foreground">
                      {draft.body}
                    </pre>
                  )}
                </div>
                {!isTerminal && (
                  <div className="flex justify-end gap-2 pt-1">
                    {editing ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSubject(draft.subject ?? "");
                            setBody(draft.body);
                            setRecipient(draft.recipient_email ?? "");
                            setEditing(false);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={saving}
                          onClick={async () => {
                            setSaving(true);
                            try {
                              await onEdit(draft.id, {
                                subject: subject || null,
                                body,
                                recipient_email: recipient || null,
                              });
                              setEditing(false);
                            } finally {
                              setSaving(false);
                            }
                          }}
                        >
                          Save
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                        <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                      </Button>
                    )}
                  </div>
                )}
              </section>

              {/* Send result if terminal */}
              {isTerminal && draft.send_result && (
                <section className="rounded-md border border-border bg-muted/20 p-3 text-xs">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Delivery
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {JSON.stringify(draft.send_result, null, 2)}
                  </pre>
                </section>
              )}
            </div>

            {/* Footer actions */}
            {!isTerminal && (
              <div className="sticky bottom-0 -mx-6 mt-6 border-t border-border bg-card px-6 py-3">
                <DialogFooterActions
                  onApprove={() => onApprove(draft.id)}
                  onOpenDismiss={() => setDismissOpen(true)}
                  busy={busy}
                />
              </div>
            )}

            <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
              <DialogTrigger asChild>
                <span />
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dismiss draft</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Optional reason — helps the agent learn to be more selective.
                </p>
                <Textarea
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  placeholder="e.g. Owner already resolved this."
                  rows={3}
                />
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDismissOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      setDismissOpen(false);
                      onDismiss(draft.id, dismissReason.trim() || null);
                      setDismissReason("");
                    }}
                  >
                    Dismiss
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DialogFooterActions({
  onApprove,
  onOpenDismiss,
  busy,
}: {
  onApprove: () => void;
  onOpenDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={onOpenDismiss} disabled={busy}>
        <X className="mr-1.5 h-4 w-4" /> Dismiss
      </Button>
      <div className="flex-1" />
      <Button onClick={onApprove} disabled={busy}>
        {busy ? (
          <>
            <Send className="mr-1.5 h-4 w-4 animate-pulse" /> Sending…
          </>
        ) : (
          <>
            <Check className="mr-1.5 h-4 w-4" /> Approve &amp; send
          </>
        )}
      </Button>
    </div>
  );
}

function SourceLink({ kind, keyStr }: { kind: string; keyStr: string }) {
  // Best-effort deep-link into the existing detail pages.
  const encoded = encodeURIComponent(keyStr);
  switch (kind) {
    case "person":
      return (
        <Link
          to="/agent/person/$key"
          params={{ key: encoded }}
          className="text-xs text-primary hover:underline"
        >
          Open person
        </Link>
      );
    case "project":
      return (
        <Link
          to="/agent/project/$projectId"
          params={{ projectId: encoded }}
          className="text-xs text-primary hover:underline"
        >
          Open project
        </Link>
      );
    case "stage":
      return (
        <Link
          to="/agent/stage/$key"
          params={{ key: encoded }}
          className="text-xs text-primary hover:underline"
        >
          Open stage
        </Link>
      );
    case "row":
      return (
        <Link
          to="/agent/row/$key"
          params={{ key: encoded }}
          className="text-xs text-primary hover:underline"
        >
          Open row
        </Link>
      );
    case "kpi":
      return (
        <Link
          to="/agent/kpi/$id"
          params={{ id: encoded }}
          className="text-xs text-primary hover:underline"
        >
          Open KPI
        </Link>
      );
    default:
      return null;
  }
}
