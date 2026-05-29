import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuper } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({ meta: [{ title: "Users — DelayLens" }] }),
  component: UsersPage,
});

type AppRole = "super_admin" | "admin" | "user";
type Row = { id: string; full_name: string; email: string; roles: AppRole[] };

function UsersPage() {
  const isSuper = useIsSuper();
  const qc = useQueryClient();

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

  if (!isSuper) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Super admins only.</div>;
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Users & Roles</h1>
      <Card className="mt-6 divide-y divide-border/60">
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
    </div>
  );
}
