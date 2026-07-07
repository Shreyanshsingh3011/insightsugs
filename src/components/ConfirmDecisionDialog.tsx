// Confirmation modal shown before an admin approves or rejects any
// pending_action or signup_request. Re-displays the before/after diff so
// the reviewer can double-check what will change.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/dialog-confirm";
import { Textarea } from "@/components/ui/textarea";
import { useState, useEffect } from "react";
import { ArrowRight, MinusCircle, PlusCircle, Check, X } from "lucide-react";

export type ConfirmDiff = {
  description: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function DiffPanel({ label, data, tone }: {
  label: string;
  data: Record<string, unknown> | null;
  tone: "before" | "after";
}) {
  const empty = !data || Object.keys(data).length === 0;
  const Icon = tone === "after" ? PlusCircle : MinusCircle;
  return (
    <div className={`rounded-md border p-2 ${tone === "after" ? "border-emerald-500/40 bg-emerald-500/5" : "border-muted-foreground/20 bg-muted/30"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium mb-1 ${tone === "after" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
        <Icon className="h-3 w-3" /> {label}
      </div>
      {empty ? (
        <div className="text-[11px] italic text-muted-foreground">— none —</div>
      ) : (
        <dl className="space-y-0.5">
          {Object.entries(data).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <dt className="text-muted-foreground min-w-24">{k}</dt>
              <dd className="text-foreground break-all">
                {v === null || v === undefined
                  ? <span className="italic text-muted-foreground">null</span>
                  : typeof v === "object"
                  ? JSON.stringify(v)
                  : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function ConfirmDecisionDialog({
  open,
  onOpenChange,
  decision,
  title,
  subtitle,
  diff,
  onConfirm,
  loading,
  askNote = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  decision: "approve" | "reject";
  title: string;
  subtitle?: string;
  diff: ConfirmDiff;
  onConfirm: (note?: string) => void;
  loading?: boolean;
  askNote?: boolean;
}) {
  const [note, setNote] = useState("");
  useEffect(() => { if (!open) setNote(""); }, [open]);

  const isApprove = decision === "approve";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isApprove ? <Check className="h-4 w-4 text-emerald-500" /> : <X className="h-4 w-4 text-destructive" />}
            Confirm {isApprove ? "approval" : "rejection"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <div>
                <div className="text-sm text-foreground font-medium">{title}</div>
                {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
              </div>
              <div className="rounded-md border bg-muted/20 p-2 space-y-2">
                <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5 flex-wrap">
                  Diff <ArrowRight className="h-3 w-3" />
                  <span className="text-foreground">{diff.description}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <DiffPanel label="Before" data={diff.before} tone="before" />
                  <DiffPanel label="After" data={diff.after} tone="after" />
                </div>
              </div>
              {askNote && (
                <div>
                  <label className="text-xs text-muted-foreground">
                    {isApprove ? "Note (optional)" : "Reason (optional)"}
                  </label>
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    className="mt-1 text-sm"
                    placeholder={isApprove ? "Anything to record with this approval…" : "Why is this being rejected?"}
                  />
                </div>
              )}
              <div className="text-[11px] text-muted-foreground">
                This decision is recorded in the audit log with your name and the current timestamp.
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); onConfirm(note.trim() || undefined); }}
            disabled={loading}
            className={isApprove ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
          >
            {loading ? "Working…" : isApprove ? "Approve" : "Reject"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
