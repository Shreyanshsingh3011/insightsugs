import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buildRowQualityReport, ROW_QUALITY_LABEL, type RowQualityIssueKind } from "@/lib/row-quality";

/**
 * Aggregate data-quality chip shown alongside dashboard KPI strips.
 * Silent when the current row set is clean so we don't add noise for
 * projects with well-behaved sheets.
 */
export function RowQualitySummary({
  rows,
  label = "Source rows",
}: {
  rows: Array<Record<string, unknown>>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const report = useMemo(() => buildRowQualityReport(rows), [rows]);

  if (report.rowsWithIssues === 0) return null;

  const kinds = (Object.keys(report.counts) as RowQualityIssueKind[])
    .filter((k) => report.counts[k] > 0)
    .sort((a, b) => report.counts[b] - report.counts[a]);

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 p-2 text-left text-amber-800 dark:text-amber-300"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">
          {report.rowsWithIssues.toLocaleString()} of {report.totalRows.toLocaleString()} {label.toLowerCase()}
          {" "}need attention
        </span>
        <span className="text-muted-foreground">
          · {report.issues.length} issue{report.issues.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-amber-500/20 p-2">
          <div className="flex flex-wrap gap-1">
            {kinds.map((k) => (
              <Badge
                key={k}
                variant="outline"
                className="gap-1 border-amber-500/40 bg-background text-[10px]"
                title={ROW_QUALITY_LABEL[k]}
              >
                {ROW_QUALITY_LABEL[k]}
                <span className="rounded-full bg-amber-500/20 px-1">{report.counts[k]}</span>
              </Badge>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Date-serial leaks (values like 46028 / 46029) usually mean the source cell holds a
            date formatted as a number. Fix the sheet cell format, then the metrics will
            self-correct on the next refresh.
          </p>
        </div>
      )}
    </div>
  );
}
