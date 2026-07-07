import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Plus, Trash2, Save, X, Mail, Users as UsersIcon } from "lucide-react";
import { listEmailGroups, upsertEmailGroup, deleteEmailGroup } from "@/lib/email-groups.functions";
import { useIsAdmin } from "@/hooks/useSession";

export const Route = createFileRoute("/_authenticated/admin/email-groups")({
  head: () => ({ meta: [{ title: "Email groups — DelayLens" }] }),
  component: EmailGroupsPage,
});

type GroupRow = {
  id: string;
  name: string;
  description: string | null;
  applies_to: { severities?: string[]; stages?: string[]; activities?: string[]; alert_types?: string[] } | null;
  members: { id: string; email: string; name: string | null }[];
};

const SEVERITIES = ["Critical", "High", "Medium", "Low"];

function EmailGroupsPage() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const listFn = useServerFn(listEmailGroups);
  const upsertFn = useServerFn(upsertEmailGroup);
  const deleteFn = useServerFn(deleteEmailGroup);

  const { data: groups, isLoading } = useQuery<GroupRow[]>({
    queryKey: ["email-groups"],
    queryFn: () => listFn(),
    enabled: isAdmin,
  });

  const [editing, setEditing] = useState<Partial<GroupRow> | null>(null);

  const upsertMut = useMutation({
    mutationFn: (payload: any) => upsertFn({ data: payload }),
    onSuccess: () => {
      toast.success("Group saved");
      setEditing(null);
      qc.invalidateQueries({ queryKey: ["email-groups"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["email-groups"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });

  if (!isAdmin) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-muted-foreground">Admins only.</div>;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <UsersIcon className="h-4 w-4" /> Email groups
          </h1>
          <p className="text-xs text-muted-foreground">
            Saved recipient sets you can pick when sending alerts. Add filters to auto-suggest a group for matching flags.
          </p>
        </div>
        {!editing && (
          <Button size="sm" onClick={() => setEditing({ name: "", description: "", applies_to: {}, members: [] })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New group
          </Button>
        )}
      </div>

      {editing && (
        <GroupEditor
          value={editing}
          onCancel={() => setEditing(null)}
          onSave={(payload) => upsertMut.mutate(payload)}
          saving={upsertMut.isPending}
        />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!editing && (
        <div className="mt-4 space-y-3">
          {(groups ?? []).map((g) => (
            <Card key={g.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{g.name}</p>
                  {g.description && <p className="mt-0.5 text-xs text-muted-foreground">{g.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(g.applies_to?.severities ?? []).map((s) => (
                      <span key={s} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        Sev: {s}
                      </span>
                    ))}
                    {(g.applies_to?.stages ?? []).map((s) => (
                      <span key={s} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                        Stage: {s}
                      </span>
                    ))}
                    {(g.applies_to?.activities ?? []).slice(0, 4).map((s) => (
                      <span key={s} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                        Activity: {s}
                      </span>
                    ))}
                  </div>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Mail className="h-3 w-3" /> {g.members.length} recipient{g.members.length === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(g)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => {
                    if (confirm(`Delete group "${g.name}"?`)) deleteMut.mutate(g.id);
                  }}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
          {!isLoading && !(groups ?? []).length && (
            <Card className="p-10 text-center text-sm text-muted-foreground">
              No email groups yet. Create one to start sending alerts to saved recipient sets.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function GroupEditor({
  value, onCancel, onSave, saving,
}: {
  value: Partial<GroupRow>;
  onCancel: () => void;
  onSave: (p: any) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(value.name ?? "");
  const [description, setDescription] = useState(value.description ?? "");
  const [severities, setSeverities] = useState<string[]>(value.applies_to?.severities ?? []);
  const [stages, setStages] = useState((value.applies_to?.stages ?? []).join(", "));
  const [activities, setActivities] = useState((value.applies_to?.activities ?? []).join(", "));
  const [membersText, setMembersText] = useState(
    (value.members ?? []).map((m) => m.name ? `${m.name} <${m.email}>` : m.email).join("\n")
  );

  const parsedMembers = useMemo(() => {
    const out: { email: string; name: string | null }[] = [];
    for (const raw of membersText.split(/[\n,;]+/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) {
        out.push({ name: m[1].trim() || null, email: m[2].trim() });
      } else if (line.includes("@")) {
        out.push({ name: null, email: line });
      }
    }
    return out;
  }, [membersText]);

  const toggleSev = (s: string) => {
    setSeverities((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };

  const submit = () => {
    if (!name.trim()) return toast.error("Name is required");
    if (!parsedMembers.length) return toast.error("Add at least one recipient");
    const splitList = (s: string) => s.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
    onSave({
      id: value.id,
      name: name.trim(),
      description: description.trim() || null,
      applies_to: {
        severities,
        stages: splitList(stages),
        activities: splitList(activities),
      },
      members: parsedMembers,
    });
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{value.id ? "Edit group" : "New group"}</p>
        <Button variant="ghost" size="sm" onClick={onCancel}><X className="h-3.5 w-3.5" /></Button>
      </div>

      <div className="mt-4 grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Group name</Label>
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Civil leads" maxLength={120} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="desc">Description (optional)</Label>
          <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>

        <div className="grid gap-1.5">
          <Label>Auto-suggest for severities</Label>
          <div className="flex flex-wrap gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleSev(s)}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  severities.includes(s)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="stages">Auto-suggest for stages (comma-separated)</Label>
          <Input id="stages" value={stages} onChange={(e) => setStages(e.target.value)} placeholder="e.g. Permits, Tendering" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="activities">Auto-suggest for activities (comma-separated)</Label>
          <Input id="activities" value={activities} onChange={(e) => setActivities(e.target.value)} placeholder="exact activity names" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="members">
            Recipients <span className="text-xs text-muted-foreground">(one per line: email or "Name &lt;email&gt;")</span>
          </Label>
          <Textarea
            id="members"
            value={membersText}
            onChange={(e) => setMembersText(e.target.value)}
            rows={8}
            placeholder={`jane@acme.com\nJohn Doe <john@acme.com>`}
          />
          <p className="text-xs text-muted-foreground">{parsedMembers.length} valid email{parsedMembers.length === 1 ? "" : "s"}.</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save group"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
