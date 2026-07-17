import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ROW_QUALITY_LABEL, type RowQualityIssue } from "@/lib/row-quality";
import { RowQualityFixButton } from "@/components/RowQualityFixButton";

/**
 * Inline pill for a single row. Renders nothing when the row is clean, so it
 * is safe to drop into every row-rendering surface (project detail lists,
 * KPI drill-downs, agent inbox, etc.).
 */
export function RowQualityBadge({ issues }: { issues: RowQualityIssue[] | undefined }) {
  if (!issues || issues.length === 0) return null;
  const kinds = Array.from(new Set(issues.map((i) => i.kind)));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="h-3 w-3" />
          {issues.length} data issue{issues.length === 1 ? "" : "s"}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        <div className="mb-1 font-medium">Row data quality</div>
        <ul className="space-y-0.5">
          {issues.slice(0, 6).map((i, k) => (
            <li key={k}>
              <span className="font-medium">{ROW_QUALITY_LABEL[i.kind]}:</span>{" "}
              <span className="text-muted-foreground">{i.message}</span>
            </li>
          ))}
        </ul>
        {kinds.length > 0 && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            Affects: {kinds.map((k) => ROW_QUALITY_LABEL[k]).join(" · ")}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
