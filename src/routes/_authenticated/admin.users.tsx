import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuper } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Clock, ShieldCheck } from "lucide-react";
import {
  listSignupRequests,
  approveSignupFn,
  rejectSignupFn,
  type PendingRequest,
} from "@/lib/signup-verify.functions";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({ meta: [{ title: "Users — DelayLens" }] }),
  component: UsersPage,
});

type AppRole = "super_admin" | "admin" | "user";
type Row = { id: string; full_name: string; email: string; roles: AppRole[] };

function UsersPage() {
  const isSuper = useIsSuper();
  const qc = useQueryClient();
  const listFn = useServerFn(listSignupRequests);
  const approveFn = useServerFn(approveSignupFn);
  const rejectFn = useServerFn(rejectSignupFn);

  const { data } = useQuery({
    queryKey: ["users-with-roles"],
    enabled: isSuper,
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
    enabled: isSuper,
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

  if (!isSuper) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Super admins only.</div>;
  }

  const pending = (requestsQ.data ?? []).filter((r) => r.status === "pending");
  const reviewed = (requestsQ.data ?? []).filter((r) => r.status !== "pending").slice(0, 20);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users & Roles</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          New signups are pending until they match the allowlist sheet or you approve them here.
        </p>
      </div>

      {/* PENDING SIGNUPS */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <Clock className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Pending signups</h2>
          <Badge variant="secondary">{pending.length}</Badge>
        </div>
        <Card className="divide-y divide-border/60">
          {pending.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">No pending requests.</div>
          )}
          {pending.map((r) => (
            <PendingRow
              key={r.id}
              req={r}
              onApprove={(role) => approve.mutate({ requestId: r.id, role })}
              onReject={(reason) => reject.mutate({ requestId: r.id, reason })}
            />
          ))}
        </Card>
      </section>

      {/* REVIEWED HISTORY */}
      {reviewed.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recently reviewed</h2>
          <Card className="divide-y divide-border/60">
            {reviewed.map((r) => (
              <div key={r.id} className="flex items-center gap-3 p-3 text-sm">
                {r.status === "approved" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <XCircle className="h-4 w-4 text-rose-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.full_name || "(no name)"}</div>
                  <div className="truncate text-xs text-muted-foreground">{r.email}</div>
                </div>
                <Badge variant="outline" className="capitalize">{r.status}</Badge>
                {r.granted_role && <Badge variant="secondary">{r.granted_role}</Badge>}
                {r.verified_via && (
                  <span className="text-[11px] text-muted-foreground">via {r.verified_via}</span>
                )}
              </div>
            ))}
          </Card>
        </section>
      )}

      {/* ALL USERS */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">All users</h2>
        </div>
        <Card className="divide-y divide-border/60">
          {data?.map((u) => {
            const current = (u.roles[0] ?? "user") as AppRole;
            return (
              <div key={u.id} className="flex items-center gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{u.full_name || "(no name)"}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </div>
                <Select value={current} onValueChange={(v) => setRole.mutate({ userId: u.id, role: v as AppRole })}>
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
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
      </section>
    </div>
  );
}

function PendingRow({ req, onApprove, onReject }: {
  req: PendingRequest;
  onApprove: (role: AppRole) => void;
  onReject: (reason: string) => void;
}) {
  const [role, setRole] = useState<AppRole>(req.requested_role);
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-col gap-2 p-4 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{req.full_name || "(no name)"}</div>
        <div className="truncate text-xs text-muted-foreground">{req.email}</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Requested <b className="capitalize">{req.requested_role}</b> · {new Date(req.created_at).toLocaleString()}
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
      </div>
    </div>
  );
}
