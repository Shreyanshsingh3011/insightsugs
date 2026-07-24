import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { getMyRoles } from "@/lib/role-check.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus } from "lucide-react";

type Profile = { id: string; full_name: string | null; email: string | null };
type Project = { id: string; name: string };

export function NewActivityForm({ onCreated }: { onCreated?: () => void }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const fetchRoles = useServerFn(getMyRoles);
  const { data: roleData } = useQuery({
    queryKey: ["my-roles", userId],
    enabled: !!userId,
    queryFn: () => fetchRoles(),
  });
  const isAdmin =
    roleData?.roles?.includes("admin") || roleData?.roles?.includes("super_admin");

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string>("");
  const [newProjectName, setNewProjectName] = useState("");
  const [assigneeId, setAssigneeId] = useState<string>("");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [tatDays, setTatDays] = useState("");

  const { data: projects } = useQuery({
    queryKey: ["projects-for-new-activity"],
    enabled: open && !!isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return data as Project[];
    },
  });

  const { data: profiles } = useQuery({
    queryKey: ["profiles-for-new-activity"],
    enabled: open && !!isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .order("full_name");
      if (error) throw error;
      return data as Profile[];
    },
  });

  const reset = () => {
    setTitle("");
    setDescription("");
    setProjectId("");
    setNewProjectName("");
    setAssigneeId("");
    setStartDate("");
    setDueDate("");
    setTatDays("");
  };

  const createActivity = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Title is required");
      if (!assigneeId) throw new Error("Pick an assignee");

      let pid = projectId;
      if (pid === "__new__") {
        if (!newProjectName.trim()) throw new Error("Enter a project name");
        const { data: p, error: pe } = await supabase
          .from("projects")
          .insert({ name: newProjectName.trim(), owner_id: userId! })
          .select("id")
          .single();
        if (pe) throw pe;
        pid = p.id;
      }
      if (!pid) throw new Error("Pick a project");

      const payload: Record<string, unknown> = {
        project_id: pid,
        title: title.trim(),
        description: description.trim() || null,
        assignee_id: assigneeId,
        status: "pending",
        start_date: startDate || null,
        due_date: dueDate || null,
        tat_days: tatDays ? Number(tatDays) : null,
      };
      const { data, error } = await supabase
        .from("activities")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;

      await supabase.from("audit_log").insert({
        actor_id: userId!,
        activity_id: data.id,
        event_type: "activity_created",
        details: { title: title.trim(), assignee_id: assigneeId, project_id: pid },
      });
    },
    onSuccess: () => {
      toast.success("Activity created");
      qc.invalidateQueries({ queryKey: ["my-activities"] });
      qc.invalidateQueries({ queryKey: ["my-activity-feed"] });
      reset();
      setOpen(false);
      onCreated?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!isAdmin) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> New activity
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New activity</DialogTitle>
          <DialogDescription>
            Create and assign an activity. Great for testing or quick day-to-day tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Draft NIT-58 status note"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Optional context or checklist"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Project</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent>
                  {projects?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                  <SelectItem value="__new__">+ New project…</SelectItem>
                </SelectContent>
              </Select>
              {projectId === "__new__" && (
                <Input
                  className="mt-2"
                  placeholder="New project name"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Assignee</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select assignee" />
                </SelectTrigger>
                <SelectContent>
                  {userId && (
                    <SelectItem value={userId}>Me</SelectItem>
                  )}
                  {profiles
                    ?.filter((p) => p.id !== userId)
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.full_name || p.email || p.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Start</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Due</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>TAT (days)</Label>
              <Input
                type="number"
                min={0}
                value={tatDays}
                onChange={(e) => setTatDays(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createActivity.mutate()}
            disabled={createActivity.isPending}
          >
            {createActivity.isPending ? "Creating…" : "Create activity"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewActivityForm;
