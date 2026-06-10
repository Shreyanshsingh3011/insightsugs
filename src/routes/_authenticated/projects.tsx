import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useSession, useIsAdmin } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Trash2, FileSpreadsheet } from "lucide-react";
import { computeDueDate } from "@/lib/business-days";
import { listProjectsFromSheets } from "@/lib/sheets.functions";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({ meta: [{ title: "Projects — DelayLens" }] }),
  component: ProjectsPage,
});

type Project = { id: string; name: string; code: string | null; description: string | null; owner_id: string | null };
type Activity = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  assignee_id: string | null;
  depends_on: string | null;
  start_date: string | null;
  tat_days: number | null;
  due_date: string | null;
  status: "pending" | "in_progress" | "blocked" | "completed" | "overdue";
};
type Profile = { id: string; full_name: string; email: string };

function ProjectsPage() {
  const isAdmin = useIsAdmin();
  const { userId } = useSession();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");

  const { data: projects } = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return data as Project[];
    },
  });

  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("id, full_name, email");
      if (error) throw error;
      return data as Profile[];
    },
  });

  const selected = projects?.find((p) => p.id === selectedId) ?? projects?.[0];

  const { data: activities } = useQuery({
    queryKey: ["activities", selected?.id],
    enabled: !!selected?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities").select("*").eq("project_id", selected!.id).order("created_at");
      if (error) throw error;
      return data as Activity[];
    },
  });

  const createProject = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error("Name required");
      const { error } = await supabase.from("projects").insert({
        name: newName.trim(), code: newCode.trim() || null, owner_id: userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      setCreating(false); setNewName(""); setNewCode("");
      toast.success("Project created");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const addActivity = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("activities").insert({
        project_id: selected!.id,
        title: "New activity",
        status: "pending",
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["activities", selected?.id] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const patchActivity = useMutation({
    mutationFn: async (vars: { id: string; patch: Partial<Activity> }) => {
      const current = activities?.find((a) => a.id === vars.id);
      const merged: Partial<Activity> = { ...vars.patch };
      const startISO = (merged.start_date ?? current?.start_date) ?? null;
      const tat = (merged.tat_days ?? current?.tat_days) ?? null;
      if (("start_date" in merged || "tat_days" in merged) && startISO && tat) {
        const { data: hols } = await supabase.from("holidays").select("holiday_date");
        const set = new Set((hols ?? []).map((h) => h.holiday_date as string));
        merged.due_date = computeDueDate(startISO, tat, set);
      }
      const { error } = await supabase.from("activities").update(merged).eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["activities", selected?.id] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const deleteActivity = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("activities").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["activities", selected?.id] }),
    onError: (e) => toast.error((e as Error).message),
  });

  if (!isAdmin) {
    return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Admins only.</div>;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-1.5 h-4 w-4" /> New project</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <Input placeholder="Project name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Input placeholder="Code (optional)" value={newCode} onChange={(e) => setNewCode(e.target.value)} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={() => createProject.mutate()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
        <Card className="p-2">
          {projects?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No projects yet.</p>}
          {projects?.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${selected?.id === p.id ? "bg-accent" : ""}`}
            >
              <div className="font-medium">{p.name}</div>
              {p.code && <div className="text-xs text-muted-foreground">{p.code}</div>}
            </button>
          ))}
        </Card>

        <div>
          {selected ? (
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  {selected.description && <p className="text-sm text-muted-foreground">{selected.description}</p>}
                </div>
                <Button size="sm" onClick={() => addActivity.mutate()}><Plus className="mr-1.5 h-4 w-4" />Activity</Button>
              </div>

              <div className="mt-4 space-y-2">
                {activities?.length === 0 && (
                  <p className="text-sm text-muted-foreground">No activities. Add one to start.</p>
                )}
                {activities?.map((a) => (
                  <div key={a.id} className="rounded-md border border-border/60 p-3">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
                      <Input
                        defaultValue={a.title}
                        onBlur={(e) => e.target.value !== a.title && patchActivity.mutate({ id: a.id, patch: { title: e.target.value } })}
                      />
                      <Select
                        value={a.assignee_id ?? "unassigned"}
                        onValueChange={(v) => patchActivity.mutate({ id: a.id, patch: { assignee_id: v === "unassigned" ? null : v } })}
                      >
                        <SelectTrigger><SelectValue placeholder="Assignee" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unassigned">Unassigned</SelectItem>
                          {profiles?.map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name || p.email}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input
                        type="date"
                        defaultValue={a.start_date ?? ""}
                        onBlur={(e) => patchActivity.mutate({ id: a.id, patch: { start_date: e.target.value || null } })}
                      />
                      <Input
                        type="number"
                        placeholder="TAT days"
                        defaultValue={a.tat_days ?? ""}
                        onBlur={(e) => patchActivity.mutate({ id: a.id, patch: { tat_days: e.target.value ? parseInt(e.target.value) : null } })}
                      />
                      <Button variant="ghost" size="icon" onClick={() => deleteActivity.mutate(a.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <Textarea
                      className="mt-2"
                      placeholder="Description"
                      defaultValue={a.description ?? ""}
                      onBlur={(e) => patchActivity.mutate({ id: a.id, patch: { description: e.target.value || null } })}
                    />
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card className="p-8 text-center text-muted-foreground">Pick a project or create one.</Card>
          )}
        </div>
      </div>
    </div>
  );
}
