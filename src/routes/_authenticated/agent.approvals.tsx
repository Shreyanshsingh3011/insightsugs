import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  listPendingActions,
  decidePendingAction,
  type PendingAction,
} from "@/lib/pending-actions.functions";
import {
  listSignupRequests,
  approveSignupFn,
  rejectSignupFn,
  type PendingRequest,
} from "@/lib/signup-verify.functions";
import { useIsAdmin } from "@/hooks/useSession";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDecisionDialog, type ConfirmDiff } from "@/components/ConfirmDecisionDialog";
import {
  Check, X, Loader2, ShieldCheck, ArrowLeft, UserPlus, Bot, ArrowRight, MinusCircle, PlusCircle, ScrollText,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------
// Every kind of pending action creates a row in some downstream table. The
// diff view shows what the world looks like BEFORE the action runs (usually
// "no such row") and AFTER (the concrete row to be inserted). This is
// computed purely from the payload so it works offline and is deterministic.
type DiffPair = {
  description: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};

function buildDiff(a: PendingAction): DiffPair {
  const p = (a.payload ?? {}) as Record<string, unknown>;
  switch (a.kind) {
    case "create_alert":
      return {
        description: `Insert a new row into alerts for "${p.activity ?? "?"}"`,
        before: null,
        after: {
          activity: p.activity ?? null,
          person: p.person ?? null,
          severity: p.severity ?? "warning",
          reason: p.reason ?? null,
          project: p.project ?? null,
          status: "open",
        },
      };
    case "nudge_assignee":
      return {
        description: `Send a nudge notification to ${p.person ?? "the assignee"}`,
        before: null,
        after: {
          recipient: p.person ?? null,
          kind: "nudge",
          activity: p.activity ?? null,
          message: p.message ?? null,
        },
      };
    case "notify":
      return {
        description: `Post an in-app notification`,
        before: null,
        after: {
          title: a.title ?? a.summary,
          body: p.message ?? a.summary,
          recipient: p.person ?? "team",
        },
      };
    default:
      return {
        description: `Execute custom action of kind "${a.kind}"`,
        before: null,
        after: (a.payload as Record<string, unknown>) ?? {},
      };
  }
}

function DiffBlock({ label, data, icon, tone }: {
  label: string;
  data: Record<string, unknown> | null;
  icon: React.ReactNode;
  tone: "before" | "after";
}) {
  const empty = !data || Object.keys(data).length === 0;
  return (
    <div className={`rounded-md border p-2 ${tone === "after" ? "border-emerald-500/40 bg-emerald-500/5" : "border-muted-foreground/20 bg-muted/30"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium mb-1 ${tone === "after" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
        {icon} {label}
      </div>
      {empty ? (
        <div className="text-[11px] italic text-muted-foreground">— none —</div>
      ) : (
        <dl className="space-y-0.5">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <dt className="text-muted-foreground min-w-24">{k}</dt>
              <dd className="text-foreground break-all">
                {v === null || v === undefined
                  ? <span className="italic text-muted-foreground">null</span>
                  : typeof v === "object"
                  ? JSON.stringify(v)
                  : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent actions tab
// ---------------------------------------------------------------------------
function AgentActionsTab() {
  const list = useServerFn(listPendingActions);
  const decide = useServerFn(decidePendingAction);
  const qc = useQueryClient();
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | "all">("pending");

  const { data, isLoading, error } = useQuery({
    queryKey: ["pending-actions", status],
    queryFn: () => list({ data: { status } }),
  });

  const decideMut = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject"; note?: string }) => decide({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "approve" ? "Approved & executed" : "Rejected");
      qc.invalidateQueries({ queryKey: ["pending-actions"] });
      qc.invalidateQueries({ queryKey: ["pending-actions-count"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const items = (data ?? []) as PendingAction[];
  const pendingItems = items.filter((i) => i.status === "pending");

  const [confirmState, setConfirmState] = useState<
    | null
    | { action: PendingAction; decision: "approve" | "reject" }
    | { bulk: "approve" | "reject" }
  >(null);

  const bulkApprove = () => {
    pendingItems.forEach((a) => decideMut.mutate({ id: a.id, decision: "approve" }));
  };
  const bulkReject = () => {
    pendingItems.forEach((a) => decideMut.mutate({ id: a.id, decision: "reject" }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-md border p-1 text-xs">
          {(["pending", "approved", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1 rounded ${status === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>
        {status === "pending" && pendingItems.length > 1 && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setConfirmState({ bulk: "reject" })} disabled={decideMut.isPending}>
              <X className="h-3.5 w-3.5 mr-1" /> Reject all ({pendingItems.length})
            </Button>
            <Button size="sm" onClick={() => setConfirmState({ bulk: "approve" })} disabled={decideMut.isPending}>
              <Check className="h-3.5 w-3.5 mr-1" /> Approve all ({pendingItems.length})
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {status === "all" ? "" : status} actions. Ask the copilot to propose one
            (e.g. &quot;flag activity X as critical&quot;), or use{" "}
            <Link to="/agent/planner" className="text-primary hover:underline">the planner</Link>.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((a) => {
            const diff = buildDiff(a);
            return (
              <Card key={a.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                      {a.title ?? a.summary}
                      <Badge variant="outline" className="text-[10px]">{a.kind}</Badge>
                      <Badge
                        variant={a.status === "pending" ? "secondary" : (a.status === "executed" || a.status === "approved") ? "default" : "destructive"}
                        className="text-[10px]"
                      >
                        {a.status}
                      </Badge>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">{a.summary}</div>
                  </div>
                  {a.status === "pending" ? (
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmState({ action: a, decision: "reject" })}
                        disabled={decideMut.isPending}
                      >
                        <X className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setConfirmState({ action: a, decision: "approve" })}
                        disabled={decideMut.isPending}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" /> Approve
                      </Button>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {a.rationale ? (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Rationale: </span>
                      {a.rationale}
                    </div>
                  ) : null}

                  <div className="rounded-md border bg-muted/20 p-2 space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                      Diff <ArrowRight className="h-3 w-3" /> <span className="text-foreground">{diff.description}</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <DiffBlock label="Before" data={diff.before} icon={<MinusCircle className="h-3 w-3" />} tone="before" />
                      <DiffBlock label="After" data={diff.after} icon={<PlusCircle className="h-3 w-3" />} tone="after" />
                    </div>
                  </div>

                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Raw payload</summary>
                    <pre className="mt-1 overflow-auto rounded bg-muted/50 p-2 text-[11px]">
                      {JSON.stringify(a.payload, null, 2)}
                    </pre>
                  </details>
                  <div className="text-[11px] text-muted-foreground">
                    Proposed {new Date(a.created_at).toLocaleString()}
                    {a.decided_at ? ` · decided ${new Date(a.decided_at).toLocaleString()}` : ""}
                    {a.execution_error ? ` · error: ${a.execution_error}` : ""}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDecisionDialog
        open={!!confirmState}
        onOpenChange={(o) => { if (!o) setConfirmState(null); }}
        decision={confirmState && "bulk" in confirmState ? confirmState.bulk : (confirmState?.decision ?? "approve")}
        title={
          confirmState && "bulk" in confirmState
            ? `${confirmState.bulk === "approve" ? "Approve" : "Reject"} ${pendingItems.length} pending action${pendingItems.length === 1 ? "" : "s"}`
            : confirmState ? (confirmState.action.title ?? confirmState.action.summary) : ""
        }
        subtitle={
          confirmState && "action" in confirmState
            ? `${confirmState.action.kind} · ${confirmState.action.summary}`
            : "This applies the same decision to every pending action in the list."
        }
        diff={
          confirmState && "action" in confirmState
            ? (() => { const d = buildDiff(confirmState.action); return { description: d.description, before: d.before, after: confirmState.decision === "approve" ? d.after : null }; })()
            : {
                description: confirmState && "bulk" in confirmState && confirmState.bulk === "approve"
                  ? "Execute every listed pending action"
                  : "Mark every listed pending action as rejected",
                before: { pending_actions: pendingItems.length },
                after: confirmState && "bulk" in confirmState && confirmState.bulk === "approve"
                  ? { executed: pendingItems.length }
                  : { rejected: pendingItems.length },
              }
        }
        loading={decideMut.isPending}
        askNote
        onConfirm={(note) => {
          if (!confirmState) return;
          if ("bulk" in confirmState) {
            if (confirmState.bulk === "approve") bulkApprove(); else bulkReject();
          } else {
            decideMut.mutate({ id: confirmState.action.id, decision: confirmState.decision, note });
          }
          setConfirmState(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signup requests tab (admin only)
// ---------------------------------------------------------------------------
function SignupRequestsTab() {
  const list = useServerFn(listSignupRequests);
  const approve = useServerFn(approveSignupFn);
  const reject = useServerFn(rejectSignupFn);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");

  const { data, isLoading, error } = useQuery({
    queryKey: ["signup-requests"],
    queryFn: () => list(),
  });

  const approveMut = useMutation({
    mutationFn: (v: { requestId: string; role: "user" | "admin" | "super_admin" }) =>
      approve({ data: v }),
    onSuccess: () => {
      toast.success("Login approved");
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const rejectMut = useMutation({
    mutationFn: (v: { requestId: string; reason?: string }) => reject({ data: v }),
    onSuccess: () => {
      toast.success("Login rejected");
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const items = useMemo(() => {
    const rows = (data ?? []) as PendingRequest[];
    return filter === "all" ? rows : rows.filter((r) => r.status === filter);
  }, [data, filter]);

  const [signupConfirm, setSignupConfirm] = useState<
    | null
    | { request: PendingRequest; decision: "approve"; role: "user" | "admin" | "super_admin" }
    | { request: PendingRequest; decision: "reject" }
  >(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-md border p-1 text-xs">
          {(["pending", "approved", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1 rounded ${filter === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {filter === "all" ? "" : filter} signup requests.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((r) => {
            const beforeState = { user_roles: "(none — no access)", signup_status: r.status };
            const afterState = {
              user_roles: `[${r.requested_role}]`,
              signup_status: "approved",
              verified_via: "admin",
            };
            return (
              <Card key={r.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                      {r.full_name || r.email}
                      <Badge variant="outline" className="text-[10px]">{r.requested_role}</Badge>
                      <Badge
                        variant={r.status === "pending" ? "secondary" : r.status === "approved" ? "default" : "destructive"}
                        className="text-[10px]"
                      >
                        {r.status}
                      </Badge>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">{r.email}</div>
                  </div>
                  {r.status === "pending" ? (
                    <div className="flex flex-wrap gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSignupConfirm({ request: r, decision: "reject" })}
                        disabled={approveMut.isPending || rejectMut.isPending}
                      >
                        <X className="h-3.5 w-3.5 mr-1" /> Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSignupConfirm({ request: r, decision: "approve", role: "user" })}
                        disabled={approveMut.isPending || rejectMut.isPending}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" /> Approve as user
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setSignupConfirm({ request: r, decision: "approve", role: r.requested_role })}
                        disabled={approveMut.isPending || rejectMut.isPending}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" /> Approve as {r.requested_role}
                      </Button>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  <div className="rounded-md border bg-muted/20 p-2 space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                      Diff <ArrowRight className="h-3 w-3" />{" "}
                      <span className="text-foreground">Grant sign-in access with role &quot;{r.requested_role}&quot;</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <DiffBlock label="Before" data={beforeState} icon={<MinusCircle className="h-3 w-3" />} tone="before" />
                      <DiffBlock label="After" data={afterState} icon={<PlusCircle className="h-3 w-3" />} tone="after" />
                    </div>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Requested {new Date(r.created_at).toLocaleString()}
                    {r.reviewed_at ? ` · decided ${new Date(r.reviewed_at).toLocaleString()} by ${r.reviewer_name ?? r.reviewer_email ?? "admin"}` : ""}
                    {r.reject_reason ? ` · reason: ${r.reject_reason}` : ""}
                    {r.verified_via ? ` · via ${r.verified_via}` : ""}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <ConfirmDecisionDialog
        open={!!signupConfirm}
        onOpenChange={(o) => { if (!o) setSignupConfirm(null); }}
        decision={signupConfirm?.decision ?? "approve"}
        title={signupConfirm ? (signupConfirm.request.full_name || signupConfirm.request.email) : ""}
        subtitle={signupConfirm ? `${signupConfirm.request.email} · requested role: ${signupConfirm.request.requested_role}` : ""}
        diff={
          signupConfirm
            ? signupConfirm.decision === "approve"
              ? {
                  description: `Grant sign-in access with role "${signupConfirm.role}"`,
                  before: { user_roles: "(none — no access)", signup_status: signupConfirm.request.status },
                  after: { user_roles: `[${signupConfirm.role}]`, signup_status: "approved", verified_via: "admin" },
                }
              : {
                  description: "Deny sign-in access for this account",
                  before: { user_roles: "(none — no access)", signup_status: signupConfirm.request.status },
                  after: { signup_status: "rejected" },
                }
            : { description: "", before: null, after: null }
        }
        loading={approveMut.isPending || rejectMut.isPending}
        askNote
        onConfirm={(note) => {
          if (!signupConfirm) return;
          if (signupConfirm.decision === "approve") {
            approveMut.mutate({ requestId: signupConfirm.request.id, role: signupConfirm.role });
          } else {
            rejectMut.mutate({ requestId: signupConfirm.request.id, reason: note ?? "Rejected from approvals inbox" });
          }
          setSignupConfirm(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------
function ApprovalsPage() {
  const isAdmin = useIsAdmin();
  const [tab, setTab] = useState<"agent" | "signup">("agent");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/agent" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Approval Inbox
            </h1>
            <p className="text-sm text-muted-foreground">
              Agent actions and new login requests. Nothing runs until you approve.
            </p>
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="flex gap-1 rounded-md border p-1 text-sm w-fit">
          <button
            onClick={() => setTab("agent")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded ${tab === "agent" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <Bot className="h-3.5 w-3.5" /> Agent actions
          </button>
          <button
            onClick={() => setTab("signup")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded ${tab === "signup" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            <UserPlus className="h-3.5 w-3.5" /> Login requests
          </button>
        </div>
      )}

      {tab === "agent" || !isAdmin ? <AgentActionsTab /> : <SignupRequestsTab />}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/approvals")({
  head: () => ({ meta: [{ title: "Approval Inbox — DelayLens" }] }),
  component: ApprovalsPage,
});
