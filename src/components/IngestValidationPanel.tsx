import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { validateParsedTable, type RowIssue } from "@/lib/ingest-validation";
import type { SheetType } from "@/lib/sheets-schemas";

const KIND_LABEL: Record<RowIssue["kind"], string> = {
  empty_required: "Missing required",
  bad_date: "Bad date",
  bad_number: "Bad number",
  duplicate_key: "Duplicate ID",
};

export function IngestValidationPanel({
  sheetType, headers, rows, mapping,
}: {
  sheetType: SheetType;
  headers: string[];
  rows: string[][];
  mapping: Record<string, string | null>;
}) {
  const [open, setOpen] = useState(true);
  const summary = useMemo(
    () => validateParsedTable({ sheetType, headers, rows, mapping }),
    [sheetType, headers, rows, mapping],
  );

  const hasIssues = summary.issues.length > 0
    || summary.unmappedRequired.length > 0
    || summary.duplicateHeaders.length > 0
    || summary.emptyHeaders > 0;

  const grouped = useMemo(() => {
    const byRow = new Map<number, RowIssue[]>();
    for (const i of summary.issues) {
      if (!byRow.has(i.rowIndex)) byRow.set(i.rowIndex, []);
      byRow.get(i.rowIndex)!.push(i);
    }
    return Array.from(byRow.entries()).sort((a, b) => a[0] - b[0]);
  }, [summary]);

  if (!hasIssues) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        All {summary.totalRows.toLocaleString()} rows passed validation.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 p-2 text-left text-xs text-amber-800 dark:text-amber-300"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">
          {summary.rowsWithIssues.toLocaleString()} row{summary.rowsWithIssues === 1 ? "" : "s"} need attention
        </span>
        <span className="text-muted-foreground">
          · {summary.issues.length} issue{summary.issues.length === 1 ? "" : "s"}
          {summary.unmappedRequired.length > 0 && ` · ${summary.unmappedRequired.length} required field(s) unmapped`}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-amber-500/20 p-3 text-xs">
          {summary.unmappedRequired.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-foreground">Unmapped required fields</div>
              <div className="flex flex-wrap gap-1">
                {summary.unmappedRequired.map((f) => (
                  <Badge key={f} variant="destructive" className="text-[10px]">{f}</Badge>
                ))}
              </div>
              <div className="mt-1 text-muted-foreground">
                Map a column to each of these above, or ingest will store empty values for them.
              </div>
            </div>
          )}

          {summary.duplicateHeaders.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-foreground">Duplicate headers</div>
              <div className="flex flex-wrap gap-1">
                {summary.duplicateHeaders.map((h) => (
                  <Badge key={h} variant="outline" className="text-[10px]">{h}</Badge>
                ))}
              </div>
              <div className="mt-1 text-muted-foreground">Only the last occurrence per header will be stored.</div>
            </div>
          )}

          {summary.emptyHeaders > 0 && (
            <div className="text-muted-foreground">
              {summary.emptyHeaders} column{summary.emptyHeaders === 1 ? " has" : "s have"} an empty header and will be skipped.
            </div>
          )}

          {grouped.length > 0 && (
            <div>
              <div className="mb-1 font-medium text-foreground">Row-level issues (first {Math.min(50, grouped.length)})</div>
              <div className="overflow-x-auto rounded border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-1.5">Row</th>
                      <th className="p-1.5">Column</th>
                      <th className="p-1.5">Kind</th>
                      <th className="p-1.5">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.slice(0, 50).flatMap(([rowIdx, list]) =>
                      list.map((i, k) => (
                        <tr key={`${rowIdx}-${k}`} className="border-b last:border-0">
                          <td className="p-1.5 font-mono">{rowIdx + 2}</td>
                          <td className="p-1.5">
                            {i.header}
                            {i.canonical && <span className="ml-1 text-muted-foreground">→ {i.canonical}</span>}
                          </td>
                          <td className="p-1.5">
                            <Badge variant="outline" className="text-[9px]">{KIND_LABEL[i.kind]}</Badge>
                          </td>
                          <td className="p-1.5 text-muted-foreground">{i.message}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              {grouped.length > 50 && (
                <div className="mt-1 text-muted-foreground">
                  … and {(grouped.length - 50).toLocaleString()} more rows with issues. Ingest will still load every row; fix the source or the mapping to clear these.
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between border-t border-amber-500/20 pt-2 text-muted-foreground">
            <span>Row numbers match your source file (header = row 1).</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                const csv = [
                  "row,column,canonical,kind,message,value",
                  ...summary.issues.map((i) =>
                    [i.rowIndex + 2, JSON.stringify(i.header), i.canonical ?? "", i.kind, JSON.stringify(i.message), JSON.stringify(i.value)].join(","),
                  ),
                ].join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = "ingest-validation.csv";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Export CSV
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
