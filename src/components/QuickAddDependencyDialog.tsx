import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { appendQuickDependency } from "@/lib/dependencies-quick-add.functions";

export function QuickAddDependencyDialog({
  onAdded,
  invalidateKeys = [],
}: {
  onAdded?: () => void;
  invalidateKeys?: string[][];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    activity: "",
    responsiblePerson: "",
    responsibleEmail: "",
    department: "",
    plannedEnd: "",
    status: "",
    remarks: "",
    project: "",
  });

  const add = useServerFn(appendQuickDependency);
  const qc = useQueryClient();

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const reset = () =>
    setForm({
      activity: "",
      responsiblePerson: "",
      responsibleEmail: "",
      department: "",
      plannedEnd: "",
      status: "",
      remarks: "",
      project: "",
    });

  const submit = async () => {
    if (!form.activity.trim()) {
      toast.error("Activity is required.");
      return;
    }
    setBusy(true);
    try {
      await add({ data: form });
      toast.success("Dependency added. Dashboard and chatbot will refresh.");
      for (const key of invalidateKeys) {
        qc.invalidateQueries({ queryKey: key });
      }
      qc.invalidateQueries({ queryKey: ["sheets"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onAdded?.();
      reset();
      setOpen(false);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to add dependency.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-2">
          <Plus className="h-4 w-4" /> Add dependency
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a dependency</DialogTitle>
          <DialogDescription>
            One-off row appended to your <strong>Quick Dependencies</strong>{" "}
            sheet. Rankings, filters, and the copilot include it as soon as the
            dashboard reloads.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label htmlFor="qd-activity">Activity *</Label>
            <Input
              id="qd-activity"
              value={form.activity}
              onChange={set("activity")}
              placeholder="Approve BOQ for T3 slab"
            />
          </div>
          <div>
            <Label htmlFor="qd-owner">Responsible person</Label>
            <Input
              id="qd-owner"
              value={form.responsiblePerson}
              onChange={set("responsiblePerson")}
              placeholder="Arpita Das"
            />
          </div>
          <div>
            <Label htmlFor="qd-email">Owner email</Label>
            <Input
              id="qd-email"
              type="email"
              value={form.responsibleEmail}
              onChange={set("responsibleEmail")}
              placeholder="arpita@example.com"
            />
          </div>
          <div>
            <Label htmlFor="qd-dept">Department</Label>
            <Input
              id="qd-dept"
              value={form.department}
              onChange={set("department")}
              placeholder="Civil"
            />
          </div>
          <div>
            <Label htmlFor="qd-project">Project</Label>
            <Input
              id="qd-project"
              value={form.project}
              onChange={set("project")}
              placeholder="Tower A"
            />
          </div>
          <div>
            <Label htmlFor="qd-due">Planned end</Label>
            <Input
              id="qd-due"
              type="date"
              value={form.plannedEnd}
              onChange={set("plannedEnd")}
            />
          </div>
          <div>
            <Label htmlFor="qd-status">Status</Label>
            <Input
              id="qd-status"
              value={form.status}
              onChange={set("status")}
              placeholder="In Progress"
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="qd-remarks">Remarks / reason</Label>
            <Textarea
              id="qd-remarks"
              rows={2}
              value={form.remarks}
              onChange={set("remarks")}
              placeholder="Waiting on structural drawings from consultant"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Adding…" : "Add dependency"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
