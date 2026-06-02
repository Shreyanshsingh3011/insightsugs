import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { getSheetDetail, refreshSheet } from "@/lib/sheets.functions";
import { SHEET_TYPE_LABELS, CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";

export const Route = createFileRoute("/_authenticated/sheets/$sheetId")({
  component: SheetDetailPage,
});

function SheetDetailPage() {
  const { sheetId } = Route.useParams();
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getSheetDetail);
  const refresh = useServerFn(refreshSheet);

  const detail = useQuery({
    queryKey: ["sheet-detail", sheetId],
    queryFn: () => fetchDetail({ data: { registryId: sheetId } }),
  });

  const refreshMut = useMutation({
    mutationFn: () => refresh({ data: { registryId: sheetId } }),
    onSuccess: () => {
      toast.success("Refreshed from Google");
      qc.invalidateQueries({ queryKey: ["sheet-detail", sheetId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Refresh failed"),
  });

  if (detail.isLoading) {
    return (
      <div className="flex justify-center p-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-6 text-sm text-destructive">
        {detail.error instanceof Error ? detail.error.message : "Failed to load sheet."}
      </div>
    );
  }

  const reg = detail.data.registry;
  const type = reg.sheet_type as SheetType;
  const canonicalCols = CANONICAL_FIELDS[type];
  const extraCols = Array.from(
    new Set(detail.data.rows.flatMap((r: any) => Object.keys(r.extras ?? {}))),
  );

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
            <span>tab “{reg.tab_name}”</span>
            <span>·</span>
            <span>{reg.row_count} rows</span>
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
          Refresh from Google
        </Button>
      </div>

      <Card className="overflow-hidden">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">#</th>
                {canonicalCols.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium">{c}</th>
                ))}
                {extraCols.map((c) => (
                  <th key={c} className="px-3 py-2 font-medium italic">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {detail.data.rows.length === 0 ? (
                <tr>
                  <td colSpan={canonicalCols.length + extraCols.length + 1} className="px-3 py-8 text-center text-muted-foreground">
                    No rows synced yet.
                  </td>
                </tr>
              ) : (
                detail.data.rows.map((r: any) => (
                  <tr key={r.row_index} className="border-t border-border">
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.row_index + 1}</td>
                    {canonicalCols.map((c) => (
                      <td key={c} className="px-3 py-1.5">{r.canonical?.[c] ?? ""}</td>
                    ))}
                    {extraCols.map((c) => (
                      <td key={c} className="px-3 py-1.5 text-muted-foreground">{r.extras?.[c] ?? ""}</td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {detail.data.rows.length >= 500 && (
        <p className="mt-2 text-xs text-muted-foreground">Showing first 500 rows.</p>
      )}
    </div>
  );
}
