import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { getSheetDetail, refreshSheet } from "@/lib/sheets.functions";
import { SHEET_TYPE_LABELS, CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";

export const Route = createFileRoute("/_authenticated/sheets/$sheetId")({
  validateSearch: z.object({
    highlight: z.coerce.number().int().nonnegative().optional(),
    col: z.string().optional(),
  }),
  component: SheetDetailPage,
});

const PAGE_SIZES = [100, 500, 1000, 2000];

function SheetDetailPage() {
  const { sheetId } = Route.useParams();
  const { highlight, col: highlightCol } = Route.useSearch();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normHighlightCol = highlightCol ? norm(highlightCol) : null;
  const isHitCell = (c: string) => normHighlightCol != null && norm(c) === normHighlightCol;
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getSheetDetail);
  const refresh = useServerFn(refreshSheet);

  const [pageSize, setPageSize] = useState(500);
  const [offset, setOffset] = useState(() =>
    typeof highlight === "number" ? Math.floor(highlight / 500) * 500 : 0,
  );
  const [viewMode, setViewMode] = useState<"source" | "mapped" | "both">("both");

  const highlightRef = useRef<HTMLTableRowElement | null>(null);

  const detail = useQuery({
    queryKey: ["sheet-detail", sheetId, offset, pageSize],
    queryFn: () =>
      fetchDetail({ data: { registryId: sheetId, offset, limit: pageSize } }),
    placeholderData: (prev) => prev,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15000),
  });

  // Surface background-refetch failures (initial load errors already render below)
  const lastToastedError = useRef<string | null>(null);
  useEffect(() => {
    if (!detail.isError || !detail.data) return; // only when we have cached data + a failed refetch
    const msg = detail.error instanceof Error ? detail.error.message : "Refetch failed";
    if (lastToastedError.current === msg) return;
    lastToastedError.current = msg;
    toast.error("Auto-refresh failed", {
      description: msg,
      action: { label: "Retry", onClick: () => detail.refetch() },
    });
  }, [detail.isError, detail.error, detail.data, detail.refetch]);
  useEffect(() => {
    if (detail.isSuccess) lastToastedError.current = null;
  }, [detail.isSuccess, detail.dataUpdatedAt]);

  useEffect(() => {
    if (highlight == null) return;
    // Jump to the page containing this row_index the first time we land here.
    const target = Math.floor(highlight / pageSize) * pageSize;
    if (target !== offset) setOffset(target);
  }, [highlight, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (highlight == null) return;
    if (!highlightRef.current) return;
    highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight, detail.data]);


  const refreshMut = useMutation({
    mutationFn: () => refresh({ data: { registryId: sheetId } }),
    onSuccess: () => {
      toast.success("Refreshed");
      qc.invalidateQueries({ queryKey: ["sheet-detail", sheetId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Refresh failed"),
  });

  if (detail.isLoading && !detail.data) {
    return (
      <div className="flex justify-center p-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <div className="p-6 text-sm text-destructive">
        {detail.error instanceof Error ? detail.error.message : "Failed to load sheet."}
      </div>
    );
  }

  const reg = detail.data.registry;
  const type = reg.sheet_type as SheetType;
  const canonicalCols = CANONICAL_FIELDS[type];
  const allExtraCols = Array.from(
    new Set(detail.data.rows.flatMap((r: any) => Object.keys(r.extras ?? {}))),
  );
  const populatedCanonicalCols = canonicalCols.filter((c) => {
    if (!detail.data.rows.length) return true;
    const filled = detail.data.rows.filter((r: any) => String(r.canonical?.[c] ?? "").trim().length > 0).length;
    return allExtraCols.length === 0 || filled / detail.data.rows.length >= 0.2;
  });
  const showSource = viewMode !== "mapped";
  const showMapped = viewMode !== "source";
  const extraCols = showSource ? allExtraCols : [];
  const visibleCanonicalCols = showMapped
    ? (viewMode === "mapped" ? canonicalCols : populatedCanonicalCols)
    : [];
  const dataCols = [...extraCols, ...visibleCanonicalCols];
  const total = detail.data.totalRows ?? 0;
  const end = Math.min(offset + pageSize, total);

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <div className="mb-4 flex items-center gap-2 text-sm">
        <Link to="/sheets" className="text-muted-foreground hover:underline">
          <ArrowLeft className="mr-1 inline h-4 w-4" />
          My Sheets
        </Link>
      </div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{reg.display_name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{SHEET_TYPE_LABELS[type]}</Badge>
            <span>{total.toLocaleString()} rows</span>
            <span>·</span>
            <span>
              {reg.last_refreshed_at
                ? `refreshed ${new Date(reg.last_refreshed_at).toLocaleString()}`
                : "never refreshed"}
            </span>
          </div>
        </div>
        <Button onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
          <RefreshCw className={`mr-1.5 h-4 w-4 ${refreshMut.isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {detail.isError && detail.data ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <div className="flex-1">
            <div className="font-medium">Auto-refresh failed</div>
            <div className="text-xs opacity-90">
              {detail.error instanceof Error ? detail.error.message : "Unknown error"}
              {" · showing last successful data"}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => detail.refetch()}
            disabled={detail.isFetching}
          >
            {detail.isFetching ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-3 w-3" />
            )}
            Retry
          </Button>
        </div>
      ) : null}


      {detail.data.syncWarning ? (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>{detail.data.syncWarning}</span>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">View:</span>
        {([
          ["source", `Source columns (${allExtraCols.length})`],
          ["mapped", `Mapped fields (${canonicalCols.length})`],
          ["both", "Both"],
        ] as const).map(([val, label]) => (
          <Button
            key={val}
            size="sm"
            variant={viewMode === val ? "default" : "outline"}
            onClick={() => setViewMode(val)}
          >
            {label}
          </Button>
        ))}
        <span className="ml-auto text-muted-foreground">
          Rendering {dataCols.length} column{dataCols.length === 1 ? "" : "s"}
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">#</th>
                {extraCols.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">{c}</th>
                ))}
                {visibleCanonicalCols.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium text-muted-foreground">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={dataCols.length + 1} className="px-3 py-8 text-center text-muted-foreground">
                    No rows synced yet.
                  </td>
                </tr>
              ) : (
                detail.data.rows.map((r: any) => {
                  const isHit = highlight != null && r.row_index === highlight;
                  return (
                    <tr
                      key={r.row_index}
                      ref={isHit ? highlightRef : undefined}
                      className={`border-t border-border ${
                        isHit ? "bg-amber-100 dark:bg-amber-900/40 ring-2 ring-amber-400" : ""
                      }`}
                    >
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.row_index + 1}</td>
                      {extraCols.map((c) => {
                        const hitCell = isHit && isHitCell(c);
                        return (
                          <td
                            key={c}
                            className={`px-3 py-1.5 ${hitCell ? "bg-amber-300 dark:bg-amber-500/50 ring-2 ring-amber-500 font-medium" : ""}`}
                          >
                            {r.extras?.[c] ?? ""}
                          </td>
                        );
                      })}
                      {visibleCanonicalCols.map((c) => {
                        const hitCell = isHit && isHitCell(c);
                        return (
                          <td
                            key={c}
                            className={`px-3 py-1.5 ${hitCell ? "bg-amber-300 dark:bg-amber-500/50 ring-2 ring-amber-500 font-medium text-foreground" : "text-muted-foreground"}`}
                          >
                            {r.canonical?.[c] ?? ""}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>Rows per page:</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1"
            value={pageSize}
            onChange={(e) => {
              setOffset(0);
              setPageSize(Number(e.target.value));
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {detail.isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          <span>
            {total === 0 ? "0" : `${(offset + 1).toLocaleString()}–${end.toLocaleString()}`} of {total.toLocaleString()}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={end >= total}
            onClick={() => setOffset(offset + pageSize)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
