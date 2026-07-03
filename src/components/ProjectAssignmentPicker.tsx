import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, FolderKanban } from "lucide-react";
import { saveMyAssignments } from "@/lib/user-assignments.functions";
import type { AgentProject } from "@/lib/agent-registry.functions";

export function ProjectAssignmentPicker({
  projects,
  current,
  trigger,
}: {
  projects: AgentProject[];
  current: string[];
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(current));

  useEffect(() => { if (open) setPicked(new Set(current)); }, [open, current]);

  const qc = useQueryClient();
  const saveFn = useServerFn(saveMyAssignments);
  const saveMu = useMutation({
    mutationFn: async () => {
      const chosen = projects.filter((p) => picked.has(p.id));
      return saveFn({ data: { projects: chosen.map((p) => ({ key: p.id, label: p.label })) } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-assignments"] });
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm">
            <FolderKanban className="h-4 w-4" /> My projects
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Which projects are you working on?</DialogTitle>
          <DialogDescription>
            Your Agent Dashboard, tasks, and reports will focus on these.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
          {projects.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No projects available yet.
            </p>
          )}
          {projects.map((p) => {
            const on = picked.has(p.id);
            return (
              <label
                key={p.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm transition hover:bg-accent ${on ? "bg-accent/60" : ""}`}
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => {
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (v) next.add(p.id); else next.delete(p.id);
                      return next;
                    });
                  }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{p.label}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saveMu.isPending}>
            Cancel
          </Button>
          <Button onClick={() => saveMu.mutate()} disabled={saveMu.isPending}>
            {saveMu.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save {picked.size} project{picked.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
