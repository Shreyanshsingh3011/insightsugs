import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { validateParsedTable, type RowIssue } from "@/lib/ingest-validation";
import type { SheetType } from "@/lib/sheets-schemas";

type Kind = RowIssue["kind"];

const KIND_LABEL: Record<Kind, string> = {
  empty_required: "Missing required",
  bad_date: "Bad date",
  bad_number: "Bad number",
  duplicate_key: "Duplicate ID",
};

const KIND_ORDER: Kind[] = ["empty_required", "bad_date", "bad_number", "duplicate_key"];

export function IngestValidationPanel({
  sheetType, headers, rows, mapping,
}: {
  sheetType: SheetType;
  headers: string[];
  rows: string[][];
  mapping: Record<string, string | null>;
}) {
  const [open, setOpen] = useState(true);
  const [kindFilter, setKindFilter] = useState<Kind | null>(null);
  const [columnFilter, setColumnFilter] = useState<string | null>(null);

  const summary = useMemo(
    () => validateParsedTable({ sheetType, headers, rows, mapping }),
    [sheetType, headers, rows, mapping],
  );

  const hasIssues = summary.issues.length > 0
    || summary.unmappedRequired.length > 0
    || summary.duplicateHeaders.length > 0
    || summary.emptyHeaders > 0;

  // Aggregate counts per kind and per column
  const { kindCounts, columnCounts } = useMemo(() => {
    const k: Record<Kind, number> = { empty_required: 0, bad_date: 0, bad_number: 0, duplicate_key: 0 };
    const c = new Map<string, number>();
    for (const i of summary.issues) {
      k[i.kind]++;
      c.set(i.header, (c.get(i.header) ?? 0) + 1);
    }
    return { kindCounts: k, columnCounts: c };
  }, [summary]);

  // Apply filters
  const filteredIssues = useMemo(() => summary.issues.filter((i) =>
    (!kindFilter || i.kind === kindFilter)
    && (!columnFilter || i.header === columnFilter),
  ), [summary.issues, kindFilter, columnFilter]);

  // Group filtered issues by row, and index the cells to highlight
  const groupedRows = useMemo(() => {
    const byRow = new Map<number, { issues: RowIssue[]; badCells: Set<string> }>();
    for (const i of filteredIssues) {
      let entry = byRow.get(i.rowIndex);
      if (!entry) { entry = { issues: [], badCells: new Set() }; byRow.set(i.rowIndex, entry); }
      entry.issues.push(i);
      entry.badCells.add(i.header);
    }
    return Array.from(byRow.entries()).sort((a, b) => a[0] - b[0]);
  }, [filteredIssues]);

  if (!hasIssues) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        All {summary.totalRows.toLocaleString()} rows passed validation.
      </div>
    );
  }

  const anyFilter = kindFilter !== null || columnFilter !== null;
  const previewCap = 50;
  const visibleRows = groupedRows.slice(0, previewCap);

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

          {summary.issues.length > 0 && (
            <>
              {/* Filter chips */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                  <Filter className="h-3 w-3" /> Show only rows failing:
                </div>
                <div className="flex flex-wrap gap-1">
                  {KIND_ORDER.filter((k) => kindCounts[k] > 0).map((k) => {
                    const active = kindFilter === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKindFilter(active ? null : k)}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                          active
                            ? "border-amber-500 bg-amber-500 text-white"
                            : "border-amber-500/40 bg-background hover:bg-amber-500/10"
                        }`}
                      >
                        {KIND_LABEL[k]}
                        <span className={`rounded-full px-1 ${active ? "bg-white/20" : "bg-muted"}`}>
                          {kindCounts[k]}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {columnCounts.size > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    <span className="text-[10px] text-muted-foreground">Column:</span>
                    {Array.from(columnCounts.entries())
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 8)
                      .map(([col, count]) => {
                        const active = columnFilter === col;
                        return (
                          <button
                            key={col}
                            type="button"
                            onClick={() => setColumnFilter(active ? null : col)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                              active
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background hover:bg-muted"
                            }`}
                          >
                            {col}
                            <span className={`rounded-full px-1 ${active ? "bg-white/20" : "bg-muted"}`}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                )}

                {anyFilter && (
                  <div className="flex items-center gap-2 pt-0.5 text-[10px] text-muted-foreground">
                    <span>
                      Showing {groupedRows.length.toLocaleString()} row{groupedRows.length === 1 ? "" : "s"} · {filteredIssues.length} issue{filteredIssues.length === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setKindFilter(null); setColumnFilter(null); }}
                      className="inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 hover:bg-muted"
                    >
                      <X className="h-2.5 w-2.5" /> Clear
                    </button>
                  </div>
                )}
              </div>

              {/* Row-level table with inline highlighting */}
              <div>
                <div className="mb-1 font-medium text-foreground">
                  Row-level issues {groupedRows.length > previewCap && `(first ${previewCap} of ${groupedRows.length})`}
                </div>
                <div className="overflow-x-auto rounded border bg-background">
                  <table className="w-full text-[11px]">
                    <thead className="bg-muted/50 text-left">
                      <tr>
                        <th className="sticky left-0 z-10 bg-muted/50 p-1.5">Row</th>
                        {headers.map((h) => {
                          const isBadCol = columnCounts.has(h);
                          const isFiltered = columnFilter === h;
                          return (
                            <th
                              key={h}
                              className={`p-1.5 ${isFiltered ? "bg-primary/10" : ""} ${isBadCol ? "text-amber-700 dark:text-amber-400" : ""}`}
                            >
                              {h || <span className="italic text-muted-foreground">∅</span>}
                            </th>
                          );
                        })}
                        <th className="p-1.5">Issues</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map(([rowIdx, entry]) => {
                        const row = rows[rowIdx] ?? [];
                        return (
                          <tr key={rowIdx} className="border-b bg-amber-500/5 last:border-0 hover:bg-amber-500/10">
                            <td className="sticky left-0 z-10 bg-inherit p-1.5 font-mono font-medium text-amber-700 dark:text-amber-400">
                              {rowIdx + 2}
                            </td>
                            {headers.map((h, ci) => {
                              const bad = entry.badCells.has(h);
                              const val = row[ci] ?? "";
                              return (
                                <td
                                  key={h + ci}
                                  className={`max-w-[180px] truncate p-1.5 ${
                                    bad
                                      ? "bg-red-500/15 font-medium text-red-700 outline outline-1 outline-red-500/40 dark:text-red-400"
                                      : "text-muted-foreground"
                                  }`}
                                  title={bad ? `${h}: ${val || "(empty)"}` : val}
                                >
                                  {val === "" ? <span className="italic opacity-60">empty</span> : val}
                                </td>
                              );
                            })}
                            <td className="p-1.5">
                              <div className="flex flex-wrap gap-0.5">
                                {entry.issues.map((i, k) => (
                                  <Badge key={k} variant="outline" className="text-[9px]" title={i.message}>
                                    {KIND_LABEL[i.kind]}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {visibleRows.length === 0 && (
                        <tr>
                          <td colSpan={headers.length + 2} className="p-3 text-center text-muted-foreground">
                            No rows match the current filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {groupedRows.length > previewCap && (
                  <div className="mt-1 text-muted-foreground">
                    … and {(groupedRows.length - previewCap).toLocaleString()} more filtered rows. Export CSV to see all.
                  </div>
                )}
              </div>
            </>
          )}

          <div className="flex items-center justify-between border-t border-amber-500/20 pt-2 text-muted-foreground">
            <span>Row numbers match your source file (header = row 1).</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                const src = anyFilter ? filteredIssues : summary.issues;
                const csv = [
                  "row,column,canonical,kind,message,value",
                  ...src.map((i) =>
                    [i.rowIndex + 2, JSON.stringify(i.header), i.canonical ?? "", i.kind, JSON.stringify(i.message), JSON.stringify(i.value)].join(","),
                  ),
                ].join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = anyFilter ? "ingest-validation-filtered.csv" : "ingest-validation.csv";
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Export {anyFilter ? "filtered " : ""}CSV
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
