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
    match: z.string().optional(),
    matchCol: z.string().optional(),
    from: z.enum(["copilot", "dashboard"]).optional(),
  }),

  component: SheetDetailPage,
});

const PAGE_SIZES = [100, 500, 1000, 2000];

type PersistedSheetState = {
  offset: number;
  pageSize: number;
  viewMode: "source" | "mapped" | "both";
  scrollTop: number;
  scrollLeft: number;
};

const stateKey = (sheetId: string) => `sheet-detail-state:${sheetId}`;

function readPersisted(sheetId: string): Partial<PersistedSheetState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(stateKey(sheetId));
    return raw ? (JSON.parse(raw) as Partial<PersistedSheetState>) : {};
  } catch {
    return {};
  }
}

function SheetDetailPage() {
  const { sheetId } = Route.useParams();
  const { highlight: highlightParam, col: highlightCol, match, matchCol, from } = Route.useSearch();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normHighlightCol = highlightCol ? norm(highlightCol) : null;
  const normMatch = match ? norm(match) : null;
  const normMatchCol = matchCol ? norm(matchCol) : null;
  const isHitCell = (c: string) => normHighlightCol != null && norm(c) === normHighlightCol;
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getSheetDetail);
  const refresh = useServerFn(refreshSheet);

  const persisted = useRef<Partial<PersistedSheetState>>(readPersisted(sheetId)).current;
  const [pageSize, setPageSize] = useState<number>(persisted.pageSize ?? 500);
  const [matchedIndex, setMatchedIndex] = useState<number | null>(null);
  const highlight = highlightParam ?? matchedIndex ?? undefined;
  const [offset, setOffset] = useState(() => {
    if (typeof highlightParam === "number") {
      return Math.floor(highlightParam / (persisted.pageSize ?? 500)) * (persisted.pageSize ?? 500);
    }
    return persisted.offset ?? 0;
  });
  const [viewMode, setViewMode] = useState<"source" | "mapped" | "both">(persisted.viewMode ?? "both");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const didRestoreScroll = useRef(false);


  const highlightRef = useRef<HTMLTableRowElement | null>(null);
  const highlightCellRef = useRef<HTMLTableCellElement | null>(null);

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

  // Text-match fallback: when caller passed ?match=... (e.g. from a Next Best
  // Action "View source" link), scan the loaded rows and highlight the first
  // one where any cell (or the specified matchCol) equals/contains the needle.
  useEffect(() => {
    if (highlightParam != null || !normMatch || !detail.data) return;
    const rows = detail.data.rows as Array<{ row_index: number; canonical?: Record<string, unknown>; extras?: Record<string, unknown> }>;
    const found = rows.find((r) => {
      const cells: Array<[string, unknown]> = [
        ...Object.entries(r.canonical ?? {}),
        ...Object.entries(r.extras ?? {}),
      ];
      return cells.some(([col, val]) => {
        if (normMatchCol && norm(col) !== normMatchCol) return false;
        const s = norm(String(val ?? ""));
        return s.length > 0 && (s === normMatch || s.includes(normMatch!));
      });
    });
    setMatchedIndex(found ? found.row_index : null);
  }, [highlightParam, normMatch, normMatchCol, detail.data]);


  useEffect(() => {
    if (highlight == null) return;
    const row = highlightRef.current;
    const cell = highlightCellRef.current;
    
    if (!row) return;

    // Prefer the exact cell so far-right columns aren't clipped on narrow
    // (mobile) viewports; fall back to the row when no column was requested.
    const target = cell ?? row;
    const scroller = target.closest<HTMLElement>(".overflow-auto");
    if (!scroller) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      return;
    }
    const tRect = target.getBoundingClientRect();
    const sRect = scroller.getBoundingClientRect();
    const nextLeft = Math.max(
      0,
      scroller.scrollLeft + (tRect.left - sRect.left) - Math.max(0, (sRect.width - tRect.width) / 2),
    );
    const nextTop = Math.max(
      0,
      scroller.scrollTop + (tRect.top - sRect.top) - Math.max(0, (sRect.height - tRect.height) / 2),
    );
    scroller.scrollTo({ left: nextLeft, top: nextTop, behavior: "auto" });
    // Also nudge the page so the scroller itself is on-screen on mobile.
    scroller.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [highlight, highlightCol, detail.data]);

  // Persist filter/pagination state whenever it changes so a return trip
  // (e.g. after bouncing to Copilot) lands on the same page/view mode.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const prev = readPersisted(sheetId);
      sessionStorage.setItem(
        stateKey(sheetId),
        JSON.stringify({
          ...prev,
          offset,
          pageSize,
          viewMode,
        }),
      );
    } catch {
      /* ignore quota errors */
    }
  }, [sheetId, offset, pageSize, viewMode]);

  // Restore the last scroll position of the table scroller once rows are
  // rendered for the persisted offset. Skip when we're jumping to a highlight
  // (that effect owns the scroll target).
  useEffect(() => {
    if (didRestoreScroll.current) return;
    if (!detail.data || highlight != null) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { scrollTop = 0, scrollLeft = 0 } = persisted;
    if (scrollTop || scrollLeft) {
      scroller.scrollTo({ top: scrollTop, left: scrollLeft, behavior: "auto" });
    }
    didRestoreScroll.current = true;
  }, [detail.data, highlight, persisted]);

  // Save scroll position on scroll (throttled via rAF) and on unload.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const save = () => {
      try {
        const prev = readPersisted(sheetId);
        sessionStorage.setItem(
          stateKey(sheetId),
          JSON.stringify({
            ...prev,
            scrollTop: scroller.scrollTop,
            scrollLeft: scroller.scrollLeft,
          }),
        );
      } catch {
        /* ignore */
      }
    };
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        save();
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("beforeunload", save);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("beforeunload", save);
      if (raf) cancelAnimationFrame(raf);
      save();
    };
  }, [sheetId, detail.data]);




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
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        {from === "copilot" ? (
          <Link
            to="/copilot"
            className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 font-medium text-primary hover:bg-primary/20"
          >
            <ArrowLeft className="mr-1 inline h-4 w-4" />
            Back to Copilot
          </Link>
        ) : null}
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
                            ref={hitCell ? highlightCellRef : undefined}
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
                            ref={hitCell ? highlightCellRef : undefined}
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
