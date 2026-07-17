import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  ROW_FIX_ACTION_LABEL,
  ROW_QUALITY_LABEL,
  suggestAutoFixes,
  type RowQualityIssue,
} from "@/lib/row-quality";

/**
 * Per-row "Auto-fix suggestions" trigger. Renders nothing when there are no
 * issues. Opens a dialog that lists concrete remediations the user can apply
 * in the source sheet (or, later, via a one-click patch server function).
 */
export function RowQualityFixButton({
  row, issues, rowLabel,
}: {
  row: Record<string, unknown>;
  issues: RowQualityIssue[] | undefined;
  rowLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!issues || issues.length === 0) return null;
  const fixes = suggestAutoFixes(row, issues);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Sparkles className="h-3 w-3" />
          Auto-fix suggestions
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto-fix suggestions</DialogTitle>
          <DialogDescription>
            {rowLabel ? <>Recommendations for <span className="font-medium">{rowLabel}</span>.</> : "Recommendations for this row."}
            {" "}Apply them in the source sheet — the next refresh will pick up the fix.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Detected issues</div>
          <div className="flex flex-wrap gap-1">
            {issues.map((i, k) => (
              <Badge key={k} variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400">
                {ROW_QUALITY_LABEL[i.kind]}
              </Badge>
            ))}
          </div>
        </div>

        <ol className="space-y-2 text-sm">
          {fixes.map((f, k) => (
            <li key={k} className="rounded-md border bg-muted/30 p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold">{f.column}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {ROW_FIX_ACTION_LABEL[f.action]}
                  {f.value != null && <> · <code className="ml-1">{f.value}</code></>}
                </Badge>
              </div>
              {f.formula && (
                <div className="mb-1 font-mono text-[11px] text-primary">{f.formula}</div>
              )}
              <div className="text-xs text-muted-foreground">{f.rationale}</div>
            </li>
          ))}
        </ol>

        <p className="text-[11px] text-muted-foreground">
          These are recommendations only — nothing is written back to the sheet automatically. Applying "Clear cell" or "Set value" in the source will resolve the flag on the next 2-minute refresh.
        </p>
      </DialogContent>
    </Dialog>
  );
}
