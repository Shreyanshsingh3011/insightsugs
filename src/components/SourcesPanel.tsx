import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ExternalLink, CheckCircle2, AlertTriangle, XCircle, Radio, Eye } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { listSheets, refreshSheet } from "@/lib/sheets.functions";
import { readRecentSyncAudit, type SyncAuditRow } from "@/lib/sync-audit.functions";

const AUTO_REFRESH_MS = 5 * 60 * 1000;

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function SourcesPanel() {
  const qc = useQueryClient();
  const fetchList = useServerFn(listSheets);
  const refresh = useServerFn(refreshSheet);
  const fetchAudit = useServerFn(readRecentSyncAudit);

  const sheets = useQuery({
    queryKey: ["sources-panel-list"],
    queryFn: () => fetchList(),
    refetchInterval: AUTO_REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  const audit = useQuery({
    queryKey: ["sources-panel-audit"],
    queryFn: () => fetchAudit({ data: { limit: 60 } }),
    refetchInterval: AUTO_REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  // Latest audit entry per sheet_url
  const latestBySheetUrl = useMemo(() => {
    const map = new Map<string, SyncAuditRow>();
    for (const r of audit.data?.rows ?? []) {
      if (!map.has(r.sheet_url)) map.set(r.sheet_url, r);
    }
    return map;
  }, [audit.data]);

  const refreshMut = useMutation({
    mutationFn: (id: string) => refresh({ data: { registryId: id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sources-panel-list"] });
      qc.invalidateQueries({ queryKey: ["sources-panel-audit"] });
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Refresh failed"),
  });

  const refreshAllMut = useMutation({
    mutationFn: async () => {
      const list = sheets.data?.sheets ?? [];
      const results = await Promise.allSettled(
        list.map((s: any) => refresh({ data: { registryId: s.id } })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      return { total: list.length, failed };
    },
    onSuccess: ({ total, failed }) => {
      if (failed === 0) toast.success(`Refreshed ${total} source${total === 1 ? "" : "s"}`);
      else toast.warning(`Refreshed ${total - failed}/${total} — ${failed} failed`);
      qc.invalidateQueries({ queryKey: ["sources-panel-list"] });
      qc.invalidateQueries({ queryKey: ["sources-panel-audit"] });
      qc.invalidateQueries({ queryKey: ["sheets-list"] });
    },
  });

  const list = sheets.data?.sheets ?? [];

  return (
    <Card className="mb-6 overflow-hidden border-primary/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Source sheets</h2>
          <Badge variant="outline" className="text-[10px]">{list.length}</Badge>
          <span className="text-xs text-muted-foreground">
            · auto-syncs every 5 min · dashboard reads from these
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refreshAllMut.mutate()}
          disabled={refreshAllMut.isPending || list.length === 0}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshAllMut.isPending ? "animate-spin" : ""}`} />
          Refresh all
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          No sources yet. Add a sheet below to start feeding the dashboard.
        </div>
      ) : (
        <div className="divide-y">
          {list.map((s: any) => {
            const a =
              latestBySheetUrl.get(s.apps_script_url ?? "") ??
              latestBySheetUrl.get(s.source_url ?? "");
            const hasError = !!a?.error;
            const hasWarn = !hasError && !!a?.warning;
            const Icon = hasError ? XCircle : hasWarn ? AlertTriangle : CheckCircle2;
            const color = hasError
              ? "text-destructive"
              : hasWarn
                ? "text-amber-500"
                : "text-emerald-500";
            return (
              <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <Icon className={`h-4 w-4 shrink-0 ${color}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{s.display_name}</span>
                    <Badge variant="secondary" className="text-[10px]">{s.row_count} rows</Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Last refresh: {relTime(s.last_refreshed_at)}
                    {a ? (
                      <>
                        {" · "}
                        {a.rows_added || a.rows_removed || a.rows_changed
                          ? `Δ +${a.rows_added ?? 0}/-${a.rows_removed ?? 0}/~${a.rows_changed ?? 0}`
                          : "no changes"}
                        {a.trigger_kind ? ` · ${a.trigger_kind}` : ""}
                      </>
                    ) : null}
                  </div>
                  {hasError ? (
                    <div className="mt-1 truncate text-xs text-destructive" title={a!.error!}>
                      Error: {a!.error}
                    </div>
                  ) : hasWarn ? (
                    <div className="mt-1 truncate text-xs text-amber-600" title={a!.warning!}>
                      Warning: {a!.warning}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {s.source_url ? (
                    <Button variant="ghost" size="sm" asChild title="Open sheet">
                      <a href={s.source_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refreshMut.mutate(s.id)}
                    disabled={refreshMut.isPending}
                    title="Refresh now"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${refreshMut.isPending ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
