import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useSession } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { CheckCircle2, Clock, Play, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { getMyDependentActivities } from "@/lib/sheets.functions";


export const Route = createFileRoute("/_authenticated/my-activities")({
  head: () => ({ meta: [{ title: "My Activities — DelayLens" }] }),
  component: MyActivitiesPage,
});

type Activity = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: "pending" | "in_progress" | "blocked" | "completed";
  start_date: string | null;
  due_date: string | null;
  tat_days: number | null;
  delay_reason_id: string | null;
  delay_note: string | null;
  completed_at: string | null;
};

const STATUSES = ["pending", "in_progress", "blocked", "completed"] as const;

function MyActivitiesPage() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const [delayDialog, setDelayDialog] = useState<{ activity: Activity; nextStatus: Activity["status"] } | null>(null);
  const [reasonId, setReasonId] = useState<string>("");
  const [note, setNote] = useState("");

  const { data: activities } = useQuery({
    queryKey: ["my-activities", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activities")
        .select("*")
        .eq("assignee_id", userId!)
        .order("due_date", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data as Activity[];
    },
  });
  const fetchSheetActs = useServerFn(getMyDependentActivities);
  const { data: sheetData } = useQuery({
    queryKey: ["my-sheet-activities", userId],
    enabled: !!userId,
    queryFn: () => fetchSheetActs(),
  });


  const { data: reasons } = useQuery({
    queryKey: ["delay_reasons"],
    queryFn: async () => {
      const { data, error } = await supabase.from("delay_reasons").select("*").eq("active", true);
      if (error) throw error;
      return data as { id: string; label: string }[];
    },
  });

  const updateStatus = useMutation({
    mutationFn: async (vars: { id: string; status: Activity["status"]; reason_id?: string; note?: string }) => {
      const patch: Partial<Activity> = { status: vars.status };
      if (vars.status === "completed") patch.completed_at = new Date().toISOString();
      if (vars.reason_id) patch.delay_reason_id = vars.reason_id;
      if (vars.note !== undefined) patch.delay_note = vars.note;
      const { error } = await supabase.from("activities").update(patch).eq("id", vars.id);
      if (error) throw error;
      await supabase.from("audit_log").insert({
        actor_id: userId!,
        activity_id: vars.id,
        event_type: "status_change",
        details: { to: vars.status, reason_id: vars.reason_id ?? null, note: vars.note ?? null },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-activities"] });
      toast.success("Updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const isOverdue = (a: Activity) =>
    a.status !== "completed" && a.due_date && new Date(a.due_date) < new Date();

  const requestStatusChange = (a: Activity, nextStatus: Activity["status"]) => {
    if (nextStatus === "blocked" || (nextStatus === "completed" && isOverdue(a))) {
      setDelayDialog({ activity: a, nextStatus });
      setReasonId("");
      setNote("");
    } else {
      updateStatus.mutate({ id: a.id, status: nextStatus });
    }
  };

  const submitDelayDialog = () => {
    if (!delayDialog) return;
    if (!reasonId) {
      toast.error("Pick a delay reason");
      return;
    }
    updateStatus.mutate({
      id: delayDialog.activity.id,
      status: delayDialog.nextStatus,
      reason_id: reasonId,
      note,
    });
    setDelayDialog(null);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">My Activities</h1>
      <p className="mt-1 text-sm text-muted-foreground">Tasks assigned to you. Mark blocked or late completions with a reason.</p>

      <div className="mt-6 space-y-3">
        {activities?.length === 0 && (
          <Card className="p-8 text-center text-muted-foreground">No activities assigned.</Card>
        )}
        {activities?.map((a) => (
          <Card key={a.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{a.title}</h3>
                  <StatusBadge status={a.status} />
                  {isOverdue(a) && <Badge variant="destructive" className="gap-1"><AlertTriangle className="h-3 w-3" />Overdue</Badge>}
                </div>
                {a.description && <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>}
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {a.start_date && <span>Start: {a.start_date}</span>}
                  {a.due_date && <span>Due: {a.due_date}</span>}
                  {a.tat_days && <span>TAT: {a.tat_days}d</span>}
                </div>
              </div>
              <Select value={a.status} onValueChange={(v) => requestStatusChange(a, v as Activity["status"])}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </Card>
        ))}
      </div>

      {sheetData?.rows && sheetData.rows.length > 0 && (
        <div className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <FileSpreadsheet className="h-5 w-5" /> From your sheets
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Rows from registered sheets where you appear as owner / assignee (matched by name or email).
          </p>
          <div className="mt-4 space-y-2">
            {sheetData.rows.map((r, i) => (
              <Card key={`${r.sheet_id}-${r.row_index}-${i}`} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{r.activity}</span>
                      {r.status && <Badge variant="outline">{r.status}</Badge>}
                      <Badge variant="secondary" className="text-[10px]">via {r.matched_via}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">
                      {r.sheet_name} · row {r.row_index}
                      {r.predecessor ? ` · depends on: ${r.predecessor}` : ""}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}


      <Dialog open={!!delayDialog} onOpenChange={(o) => !o && setDelayDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Why the delay?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={reasonId} onValueChange={setReasonId}>
              <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
              <SelectContent>
                {reasons?.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Textarea placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelayDialog(null)}>Cancel</Button>
            <Button onClick={submitDelayDialog}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: Activity["status"] }) {
  const map: Record<Activity["status"], { icon: React.ReactNode; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    pending: { icon: <Clock className="h-3 w-3" />, variant: "secondary" },
    in_progress: { icon: <Play className="h-3 w-3" />, variant: "default" },
    blocked: { icon: <AlertTriangle className="h-3 w-3" />, variant: "destructive" },
    completed: { icon: <CheckCircle2 className="h-3 w-3" />, variant: "outline" },
  };
  const m = map[status];
  return <Badge variant={m.variant} className="gap-1">{m.icon}{status.replace("_", " ")}</Badge>;
}
