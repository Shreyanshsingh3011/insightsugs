import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuper, useRoles } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, Clock, ShieldCheck, Send, Search, RefreshCw, ShieldAlert, KeyRound, Copy,
} from "lucide-react";
import {
  listSignupRequests,
  approveSignupFn,
  rejectSignupFn,
  resendVerificationFn,
  type PendingRequest,
} from "@/lib/signup-verify.functions";
import { seedTestLoginsFromRealEmails, type SeededLogin } from "@/lib/seed-test-logins.functions";
import { usePersistedState } from "@/hooks/usePersistedState";


export const Route = createFileRoute("/_authenticated/admin/users")({
  ssr: false,
  head: () => ({ meta: [{ title: "Users — DelayLens" }] }),
  component: UsersGate,
});

type AppRole = "super_admin" | "admin" | "user";
type Row = { id: string; full_name: string; email: string; roles: AppRole[] };

function ageDays(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function UsersGate() {
  const { data: roles, isLoading } = useRoles();
  const isSuper = useIsSuper();
  if (isLoading) {
    return <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!isSuper) {
    throw redirect({ to: "/" });
  }
  return <UsersPage />;
}

function UsersPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSignupRequests);
  const approveFn = useServerFn(approveSignupFn);
  const rejectFn = useServerFn(rejectSignupFn);
  const resendFn = useServerFn(resendVerificationFn);

  const { data } = useQuery({
    queryKey: ["users-with-roles"],
    queryFn: async (): Promise<Row[]> => {
      const [{ data: profiles, error: e1 }, { data: roles, error: e2 }] = await Promise.all([
        supabase.from("profiles").select("id, full_name, email"),
        supabase.from("user_roles").select("user_id, role"),
      ]);
      if (e1) throw e1;
      if (e2) throw e2;
      const byUser = new Map<string, AppRole[]>();
      (roles ?? []).forEach((r) => {
        const arr = byUser.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        byUser.set(r.user_id, arr);
      });
      return (profiles ?? []).map((p) => ({ ...p, roles: byUser.get(p.id) ?? [] }));
    },
  });

  const requestsQ = useQuery({
    queryKey: ["signup-requests"],
    queryFn: () => listFn(),
    refetchInterval: 20_000,
  });

  const setRole = useMutation({
    mutationFn: async (vars: { userId: string; role: AppRole }) => {
      const { error: delErr } = await supabase.from("user_roles").delete().eq("user_id", vars.userId);
      if (delErr) throw delErr;
      const { error } = await supabase.from("user_roles").insert({ user_id: vars.userId, role: vars.role });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users-with-roles"] });
      toast.success("Role updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const approve = useMutation({
    mutationFn: (v: { requestId: string; role: AppRole }) => approveFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
      qc.invalidateQueries({ queryKey: ["users-with-roles"] });
      toast.success("Signup approved");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const reject = useMutation({
    mutationFn: (v: { requestId: string; reason: string }) => rejectFn({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signup-requests"] });
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

  // ────── Pending filters (persisted across drill-downs)
  const [q, setQ] = usePersistedState<string>("admin.users.pending.q", "");
  const [statusFilter, setStatusFilter] = usePersistedState<"pending" | "approved" | "rejected" | "all">("admin.users.pending.status", "pending");
  const [ageBucket, setAgeBucket] = usePersistedState<"any" | "24h" | "3d" | "7d" | "gt7">("admin.users.pending.age", "any");

  const allRequests = requestsQ.data ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allRequests.filter((r) => {
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
  }, [allRequests, q, statusFilter, ageBucket]);

  const pending = filtered.filter((r) => r.status === "pending");
  const reviewed = filtered.filter((r) => r.status !== "pending").slice(0, 50);
  const pendingCount = allRequests.filter((r) => r.status === "pending").length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users &amp; Roles</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New signups are pending until they match the allowlist sheet or a super admin approves them here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => requestsQ.refetch()}>
          <RefreshCw className={`h-4 w-4 ${requestsQ.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* SEED TEST LOGINS */}
      <SeedTestLogins />

      {/* FILTERS */}

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name or email…"
              className="h-9 pl-8"
            />
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

      {/* PENDING SIGNUPS */}
      {statusFilter === "pending" || statusFilter === "all" ? (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-semibold">Pending signups</h2>
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
      ) : null}

      {/* REVIEWED HISTORY / AUDIT */}
      {reviewed.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Approval audit log</h2>
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
                    ) : r.verified_via === "sheet" ? (
                      <> via sheet allowlist</>
                    ) : r.verified_via === "bootstrap" ? (
                      <> via bootstrap</>
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

      {/* ALL USERS */}
      <AllUsers data={data ?? []} onSetRole={(userId, role) => setRole.mutate({ userId, role })} />
    </div>
  );
}

function AllUsers({ data, onSetRole }: { data: Row[]; onSetRole: (userId: string, role: AppRole) => void }) {
  const [q, setQ] = usePersistedState<string>("admin.users.all.q", "");
  const [roleFilter, setRoleFilter] = usePersistedState<"all" | AppRole>("admin.users.all.role", "all");
  const [page, setPage] = usePersistedState<number>("admin.users.all.page", 1);
  const pageSize = 20;

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.filter((u) => {
      const primary = (u.roles[0] ?? "user") as AppRole;
      if (roleFilter !== "all" && primary !== roleFilter) return false;
      if (!t) return true;
      return (
        (u.full_name ?? "").toLowerCase().includes(t) ||
        (u.email ?? "").toLowerCase().includes(t)
      );
    });
  }, [data, q, roleFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const view = filtered.slice(start, start + pageSize);

  // Reset to first page when filter changes.
  useEffect(() => { setPage(1); }, [q, roleFilter]);

  return (
    <section aria-labelledby="all-users-heading">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
        <h2 id="all-users-heading" className="text-sm font-semibold">All users</h2>
        <Badge variant="secondary" className="ml-1">{filtered.length}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              className="h-8 w-56 pl-7 text-xs"
              placeholder="Search name or email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search all users by name or email"
            />
          </div>
          <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as typeof roleFilter)}>
            <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter by role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="super_admin">super_admin</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="divide-y divide-border/60">
        {view.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No users match your filters.</div>
        ) : view.map((u) => {
          const current = (u.roles[0] ?? "user") as AppRole;
          return (
            <div key={u.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{u.full_name || "(no name)"}</div>
                <div className="truncate text-xs text-muted-foreground">{u.email}</div>
              </div>
              <Select value={current} onValueChange={(v) => onSetRole(u.id, v as AppRole)}>
                <SelectTrigger className="w-full sm:w-44" aria-label={`Change role for ${u.full_name || u.email}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                  <SelectItem value="super_admin">super_admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </Card>

      {filtered.length > pageSize && (
        <nav className="mt-3 flex items-center justify-between text-xs text-muted-foreground" aria-label="Pagination">
          <div>
            Showing <b className="tabular-nums">{start + 1}</b>–<b className="tabular-nums">{Math.min(start + pageSize, filtered.length)}</b> of <b className="tabular-nums">{filtered.length}</b>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage((p: number) => Math.max(1, p - 1))}>
              Previous
            </Button>
            <span className="tabular-nums">Page {currentPage} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage((p: number) => Math.min(totalPages, p + 1))}>
              Next
            </Button>
          </div>
        </nav>
      )}
    </section>
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
            <span>{new Date(req.created_at).toLocaleString()}</span>
            <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">
              {age === 0 ? "today" : `${age}d old`}
            </Badge>
            {req.notify_count ? (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                resent {req.notify_count}×
                {req.last_notified_at ? ` · ${new Date(req.last_notified_at).toLocaleDateString()}` : ""}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="super_admin">super_admin</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => onApprove(role)}>
            <CheckCircle2 className="h-4 w-4" /> Approve
          </Button>
          <Input
            className="h-8 w-40 text-xs"
            placeholder="Reject reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={() => onReject(reason)}>
            <XCircle className="h-4 w-4" /> Reject
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowResend((v) => !v)}>
            <Send className="h-4 w-4" /> Resend verification
          </Button>
        </div>
      </div>
      {showResend && (
        <div className="flex flex-wrap items-center gap-2 pl-1">
          <Input
            className="h-8 flex-1 text-xs"
            placeholder="Optional note included in the in-app message"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button size="sm" disabled={resendPending} onClick={() => { onResend(note || undefined); setNote(""); setShowResend(false); }}>
            <Send className="h-4 w-4" /> Send now
          </Button>
        </div>
      )}
    </div>
  );
}
