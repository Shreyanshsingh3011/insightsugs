// Export-this-detail split menu: download the currently visible detail
// records as CSV or PDF (both stamped with scope + date window), or escalate
// the same context by raising it as a concern to the responsible department.

import { useState } from "react";
import { Download, FileSpreadsheet, FileText, Flag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RaiseConcernDialog } from "@/components/RaiseConcernDialog";
import type { ScopedRow } from "@/lib/entity-scope";
import {
  exportDetailCSV, exportDetailPDF, type DetailExportContext,
} from "@/lib/detail-export";

export type DetailExportMenuProps = {
  rows: ScopedRow[];
  totalInScope: number;
  ctx: DetailExportContext;
  /** Prefilled department for the concern dialog. */
  targetDept?: string | null;
  ownerEmail?: string | null;
};

export function DetailExportMenu({
  rows, totalInScope, ctx, targetDept, ownerEmail,
}: DetailExportMenuProps) {
  const [openConcern, setOpenConcern] = useState(false);
  const empty = rows.length === 0;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="gap-1.5" aria-label="Export this detail">
            <Download className="h-4 w-4" />
            <span>Export</span>
            {!empty && (
              <span className="hidden sm:inline text-[10px] text-muted-foreground">
                {rows.length}/{totalInScope}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs">
            {rows.length} of {totalInScope} records
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={empty}
            onClick={() => {
              try { exportDetailCSV(rows, totalInScope, ctx); }
              catch (e) { toast.error((e as Error).message); }
            }}
          >
            <FileSpreadsheet className="h-4 w-4" /> Download CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={empty}
            onClick={() => {
              exportDetailPDF(rows, totalInScope, ctx)
                .catch((e) => toast.error((e as Error).message));
            }}
          >
            <FileText className="h-4 w-4" /> Download PDF
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setOpenConcern(true)}>
            <Flag className="h-4 w-4" /> Send as concern
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RaiseConcernDialog
        open={openConcern}
        onOpenChange={setOpenConcern}
        defaultActivity={ctx.title}
        defaultTargetDept={targetDept ?? undefined}
        ownerEmail={ownerEmail ?? undefined}
      />
    </>
  );
}
