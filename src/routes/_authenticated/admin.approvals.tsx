import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Clock, ShieldAlert, Send, Search, RefreshCw, Loader2, UserPlus,
} from "lucide-react";
import {
  listSignupRequests,
  approveSignupFn,
  rejectSignupFn,
  resendVerificationFn,
  type PendingRequest,
} from "@/lib/signup-verify.functions";
import { useIsSuper, useRoles } from "@/hooks/useSession";
import { usePersistedState } from "@/hooks/usePersistedState";

type AppRole = "super_admin" | "admin" | "user";

export const Route = createFileRoute("/_authenticated/admin/approvals")({
  ssr: false,
  head: () => ({ meta: [{ title: "Signup approvals — DelayLens" }] }),
  component: ApprovalsGate,
});

function ageDays(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function ApprovalsGate() {
  const { isLoading } = useRoles();
  const isSuper = useIsSuper();
  if (isLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!isSuper) throw redirect({ to: "/" });
  return <ApprovalsPage />;
}

function ApprovalsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSignupRequests);
  const approveFn = useServerFn(approveSignupFn);
  const rejectFn = useServerFn(rejectSignupFn);
  const resendFn = useServerFn(resendVerificationFn);

  const requestsQ = useQuery({
    queryKey: ["signup-requests"],
    queryFn: () => listFn(),
    refetchInterval: 20_000,
  });

  const approve = useMutation({
    mutationFn: (v: { requestId: string; role: AppRole }) => approveFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
      qc.invalidateQueries({ queryKey: ["pending-signups-count"] });
      toast.success("Signup approved");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const reject = useMutation({
    mutationFn: (v: { requestId: string; reason: string }) => rejectFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
      qc.invalidateQueries({ queryKey: ["pending-signups-count"] });
      toast.success("Signup rejected");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const resend = useMutation({
    mutationFn: (v: { requestId: string; note?: string }) => resendFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
      toast.success("Verification resent");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const [q, setQ] = usePersistedState<string>("admin.approvals.q", "");
  const [statusFilter, setStatusFilter] = usePersistedState<"pending" | "approved" | "rejected" | "all">("admin.approvals.status", "pending");
  const [ageBucket, setAgeBucket] = usePersistedState<"any" | "24h" | "3d" | "7d" | "gt7">("admin.approvals.age", "any");

  const all = requestsQ.data ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (needle) {
        const hay = `${r.full_name ?? ""} ${r.email ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      const d = ageDays(r.created_at);
      if (ageBucket === "24h" && d > 1) return false;
      if (ageBucket === "3d" && d > 3) return false;
      if (ageBucket === "7d" && d > 7) return false;
      if (ageBucket === "gt7" && d <= 7) return false;
      return true;
    });
  }, [all, q, statusFilter, ageBucket]);

  const pending = filtered.filter((r) => r.status === "pending");
  const reviewed = filtered.filter((r) => r.status !== "pending").slice(0, 100);
  const pendingCount = all.filter((r) => r.status === "pending").length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <UserPlus className="h-5 w-5" /> Signup &amp; login approvals
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve, reject, or resend verification for pending account requests. Full user &amp; role management lives in{" "}
            <Link to="/admin/users" className="underline underline-offset-2">Users &amp; roles</Link>.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => requestsQ.refetch()}>
          <RefreshCw className={`h-4 w-4 ${requestsQ.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or email…" className="h-9 pl-8" />
          </div>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="all">All statuses</SelectItem>
            </SelectContent>
          </Select>
          <Select value={ageBucket} onValueChange={(v) => setAgeBucket(v as typeof ageBucket)}>
            <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any age</SelectItem>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="3d">Last 3 days</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="gt7">Older than 7 days</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="secondary" className="ml-auto">
            {filtered.length} shown · {pendingCount} pending overall
          </Badge>
        </div>
      </Card>

      {(statusFilter === "pending" || statusFilter === "all") && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold">Pending</h2>
            <Badge variant="secondary">{pending.length}</Badge>
          </div>
          <Card className="divide-y divide-border/60">
            {pending.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">No pending requests match your filters.</div>
            )}
            {pending.map((r) => (
              <PendingRow
                key={r.id}
                req={r}
                onApprove={(role) => approve.mutate({ requestId: r.id, role })}
                onReject={(reason) => reject.mutate({ requestId: r.id, reason })}
                onResend={(note) => resend.mutate({ requestId: r.id, note })}
                resendPending={resend.isPending}
              />
            ))}
          </Card>
        </section>
      )}

      {reviewed.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Recent decisions</h2>
            <Badge variant="outline">{reviewed.length}</Badge>
          </div>
          <Card className="divide-y divide-border/60">
            {reviewed.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 p-3 text-sm md:flex-row md:items-start md:gap-3">
                {r.status === "approved" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {r.full_name || "(no name)"}{" "}
                    <span className="text-xs font-normal text-muted-foreground">· {r.email}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {r.status === "approved" ? "Approved" : "Rejected"}
                    {r.reviewer_name || r.reviewer_email ? (
                      <> by <b>{r.reviewer_name || r.reviewer_email}</b></>
                    ) : null}
                    {r.reviewed_at && <> · {new Date(r.reviewed_at).toLocaleString()}</>}
                  </div>
                  {r.status === "rejected" && r.reject_reason && (
                    <div className="mt-1 text-[11px] italic text-rose-700">Reason: {r.reject_reason}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="capitalize">{r.status}</Badge>
                  {r.granted_role && <Badge variant="secondary">{r.granted_role}</Badge>}
                </div>
              </div>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}

function PendingRow({ req, onApprove, onReject, onResend, resendPending }: {
  req: PendingRequest;
  onApprove: (role: AppRole) => void;
  onReject: (reason: string) => void;
  onResend: (note?: string) => void;
  resendPending: boolean;
}) {
  const [role, setRole] = useState<AppRole>(req.requested_role);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [showResend, setShowResend] = useState(false);
  const age = ageDays(req.created_at);
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{req.full_name || "(no name)"}</div>
          <div className="truncate text-xs text-muted-foreground">{req.email}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>Requested <b className="capitalize">{req.requested_role}</b></span>
            <span>·</span>
            <span>{age === 0 ? "today" : `${age}d ago`}</span>
            <span>·</span>
            <span>{new Date(req.created_at).toLocaleString()}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
            <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="super_admin">super_admin</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => onApprove(role)}>
            <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowResend((v) => !v)}>
            <Send className="mr-1 h-4 w-4" /> Resend
          </Button>
        </div>
      </div>
      {showResend && (
        <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-2 md:flex-row">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note to include in resend…"
            className="h-9"
          />
          <Button
            size="sm"
            onClick={() => { onResend(note.trim() || undefined); setNote(""); setShowResend(false); }}
            disabled={resendPending}
          >
            {resendPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
            Send verification
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2 md:flex-row">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection (required)…"
          className="h-9"
        />
        <Button
          size="sm"
          variant="destructive"
          onClick={() => { if (reason.trim()) onReject(reason.trim()); else toast.error("Add a rejection reason"); }}
        >
          <XCircle className="mr-1 h-4 w-4" /> Reject
        </Button>
      </div>
    </div>
  );
}
