import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuper } from "@/hooks/useSession";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, UserPlus, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/allowlist")({
  head: () => ({ meta: [{ title: "Signup allowlist — DelayLens" }] }),
  component: AllowlistPage,
});

type Row = {
  id: string;
  email: string;
  full_name: string | null;
  role: "user" | "admin" | "super_admin";
  note: string | null;
  created_at: string;
};

function AllowlistPage() {
  const isSuper = useIsSuper();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [note, setNote] = useState("");

  const listQ = useQuery({
    queryKey: ["signup-allowlist"],
    enabled: isSuper,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signup_allowlist")
        .select("id, email, full_name, role, note, created_at")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const e = email.trim().toLowerCase();
      if (!e) throw new Error("Email required");
      const { error } = await supabase.from("signup_allowlist").insert({
        email: e,
        full_name: name.trim() || null,
        role,
        note: note.trim() || null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Added to allowlist");
      setEmail(""); setName(""); setNote(""); setRole("user");
      qc.invalidateQueries({ queryKey: ["signup-allowlist"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeMut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("signup_allowlist").delete().eq("id", id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      toast.success("Removed");
      qc.invalidateQueries({ queryKey: ["signup-allowlist"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  if (!isSuper) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Super admins only.</div>;
  }

  const rows = listQ.data ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">Signup allowlist</h1>
      </div>
      <p className="text-sm text-muted-foreground -mt-4">
        Pre-approve people by email. New signups matching an entry here are auto-approved with the chosen role.
        Anyone not on the list stays pending and every super admin gets an in-app + email alert to review.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">Add entry</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 md:grid-cols-[1.5fr_1.5fr_0.8fr_1.5fr_auto]">
            <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input placeholder="Full name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={role} onValueChange={(v) => setRole(v as "user" | "admin")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">user</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button onClick={() => addMut.mutate()} disabled={addMut.isPending || !email.trim()}>
              <UserPlus className="h-4 w-4" /> Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Entries ({rows.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          {listQ.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
          {!listQ.isLoading && rows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              No entries yet. Every signup will require super admin approval.
            </div>
          )}
          <div className="divide-y divide-border/60">
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[1.5fr_1.5fr_0.6fr_1.5fr_auto] items-center gap-3 p-3 text-sm">
                <div className="font-medium">{r.email}</div>
                <div className="text-muted-foreground">{r.full_name || "—"}</div>
                <div><Badge variant="secondary">{r.role}</Badge></div>
                <div className="text-xs text-muted-foreground truncate">{r.note || ""}</div>
                <Button size="sm" variant="ghost" onClick={() => removeMut.mutate(r.id)} disabled={removeMut.isPending}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
