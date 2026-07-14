import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useRoles } from "@/hooks/useSession";
import {
  listBootstrapAdmins,
  addBootstrapAdmin,
  removeBootstrapAdmin,
} from "@/lib/bootstrap-admins.functions";
import { Trash2, Plus, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/bootstrap")({
  component: BootstrapAdminsPage,
  head: () => ({
    meta: [
      { title: "Bootstrap super admins" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

function BootstrapAdminsPage() {
  const { data: roles } = useRoles();
  const isSuper = !!roles?.includes("super_admin");

  const list = useServerFn(listBootstrapAdmins);
  const add = useServerFn(addBootstrapAdmin);
  const remove = useServerFn(removeBootstrapAdmin);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["bootstrap-admins"],
    enabled: isSuper,
    queryFn: () => list(),
  });

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const addMut = useMutation({
    mutationFn: () =>
      add({ data: { email: email || undefined, user_id: userId || undefined, note: note || undefined } }),
    onSuccess: () => {
      setEmail(""); setUserId(""); setNote(""); setErr(null);
      qc.invalidateQueries({ queryKey: ["bootstrap-admins"] });
    },
    onError: (e: any) => setErr(String(e?.message ?? e)),
  });

  const rmMut = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bootstrap-admins"] }),
  });

  if (!isSuper) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldAlert className="h-4 w-4" /> Super admin only.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Bootstrap super admins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Emails and user IDs in this list are always granted <code>super_admin</code> on
          sign-in, even if their role row is missing. Use sparingly — this bypasses the
          normal approvals flow.
        </p>
      </header>

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-medium">Add entry</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            className="rounded-md border px-3 py-2 text-sm bg-background"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="rounded-md border px-3 py-2 text-sm bg-background"
            placeholder="user UUID (optional)"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <input
            className="rounded-md border px-3 py-2 text-sm bg-background sm:col-span-2"
            placeholder="note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button
          className="inline-flex items-center gap-2 rounded-md bg-foreground text-background px-3 py-2 text-sm disabled:opacity-50"
          disabled={addMut.isPending || (!email && !userId)}
          onClick={() => addMut.mutate()}
        >
          <Plus className="h-4 w-4" /> {addMut.isPending ? "Adding…" : "Add"}
        </button>
      </section>

      <section className="rounded-lg border">
        <div className="border-b p-3 text-sm font-medium">Current entries</div>
        {q.isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : q.error ? (
          <div className="p-4 text-sm text-red-600">{String((q.error as any)?.message ?? q.error)}</div>
        ) : !q.data?.length ? (
          <div className="p-4 text-sm text-muted-foreground">No entries.</div>
        ) : (
          <ul className="divide-y">
            {q.data.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="text-sm font-mono truncate">
                    {row.email ?? row.user_id}
                  </div>
                  {row.note && (
                    <div className="text-xs text-muted-foreground truncate">{row.note}</div>
                  )}
                </div>
                <button
                  className="inline-flex items-center gap-1 text-red-600 text-sm hover:underline disabled:opacity-50"
                  disabled={rmMut.isPending}
                  onClick={() => {
                    if (confirm(`Remove ${row.email ?? row.user_id}?`)) rmMut.mutate(row.id);
                  }}
                >
                  <Trash2 className="h-4 w-4" /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
