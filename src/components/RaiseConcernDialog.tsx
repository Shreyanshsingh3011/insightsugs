import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { raiseConcern, listDepartments } from "@/lib/concerns.functions";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultActivity?: string | null;
  defaultTargetDept?: string | null;
  ownerEmail?: string | null;
  registryId?: string | null;
  rowIndex?: number | null;
}

const SEVERITIES = ["Low", "Medium", "High", "Critical"] as const;

export function RaiseConcernDialog({
  open,
  onOpenChange,
  defaultActivity,
  defaultTargetDept,
  ownerEmail,
  registryId,
  rowIndex,
}: Props) {
  const listDeptsFn = useServerFn(listDepartments);
  const raiseFn = useServerFn(raiseConcern);

  const { data: deptData } = useQuery({
    queryKey: ["departments"],
    queryFn: () => listDeptsFn(),
    enabled: open,
  });

  const [targetDept, setTargetDept] = useState(defaultTargetDept ?? "");
  const [severity, setSeverity] = useState<typeof SEVERITIES[number]>("Medium");
  const [title, setTitle] = useState(defaultActivity ? `Concern: ${defaultActivity}` : "");
  const [body, setBody] = useState("");
  const [deptCustom, setDeptCustom] = useState("");

  useEffect(() => {
    if (open) {
      setTargetDept(defaultTargetDept ?? "");
      setTitle(defaultActivity ? `Concern: ${defaultActivity}` : "");
      setBody("");
      setSeverity("Medium");
      setDeptCustom("");
    }
  }, [open, defaultActivity, defaultTargetDept]);

  const mut = useMutation({
    mutationFn: () =>
      raiseFn({
        data: {
          target_dept: (targetDept === "__other__" ? deptCustom : targetDept).trim(),
          title: title.trim(),
          body: body.trim(),
          severity,
          activity: defaultActivity ?? null,
          owner_email: ownerEmail ?? null,
          registry_id: registryId ?? null,
          row_index: rowIndex ?? null,
        },
      }),
    onSuccess: (r: any) => {
      toast.success(`Concern raised — ${r.recipientCount} recipient(s) notified`);
      onOpenChange(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to raise concern"),
  });

  const finalDept = targetDept === "__other__" ? deptCustom.trim() : targetDept.trim();
  const canSubmit = !!finalDept && !!title.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Raise a concern
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Target department</Label>
            <Select value={targetDept} onValueChange={setTargetDept}>
              <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent>
                {(deptData?.departments ?? []).map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
                <SelectItem value="__other__">Other…</SelectItem>
              </SelectContent>
            </Select>
            {targetDept === "__other__" && (
              <Input
                value={deptCustom}
                onChange={(e) => setDeptCustom(e.target.value)}
                placeholder="Type department name"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </div>

          <div className="space-y-2">
            <Label>Note</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder="What's the issue? What outcome do you need?"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => mut.mutate()} disabled={!canSubmit || mut.isPending}>
            {mut.isPending ? "Sending…" : "Raise concern"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
