import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { readRecentSyncAudit, type SyncAuditRow } from "@/lib/sync-audit.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { useMemo } from "react";

export const Route = createFileRoute("/_authenticated/admin/sync-perf")({
  head: () => ({
    meta: [
      { title: "Sync Performance — Admin" },
      { name: "description", content: "Cron run timing, rows changed, and embed-backfill instrumentation." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SyncPerfPage,
});

function SyncPerfPage() {
  const readAudit = useServerFn(readRecentSyncAudit);
  const q = useQuery({
    queryKey: ["admin", "sync-perf"],
    queryFn: () => readAudit({ data: { limit: 200 } }),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const rows = q.data?.rows ?? [];
  const stats = useMemo(() => summarize(rows), [rows]);

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sync Performance</h1>
          <p className="text-sm text-muted-foreground">
            Cron run duration, rows changed, and embed-backfill throughput. A "hash match" run writes zero rows and skips WAL entirely — good.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin">Back to Admin</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${q.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {q.isError && (
        <Card><CardContent className="p-4 text-sm text-destructive">
          Failed to load audit rows: {(q.error as Error)?.message ?? "unknown error"}
        </CardContent></Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Sheet-refresh runs (recent)" value={stats.refreshRuns} />
        <Stat label="Unchanged (hash skip)" value={stats.unchanged} sub={`${stats.unchangedPct}% skipped`} />
        <Stat label="Avg refresh duration" value={`${stats.avgFetchMs}ms`} />
        <Stat label="Total rows changed" value={stats.rowsChangedSum} />
        <Stat label="Embed-backfill runs" value={stats.embedRuns} />
        <Stat label="Rows embedded" value={stats.embeddedSum} />
        <Stat label="Avg embed duration" value={`${stats.avgEmbedMs}ms`} />
        <Stat label="Errors (recent)" value={stats.errors} tone={stats.errors > 0 ? "danger" : undefined} />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs ({rows.length})</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-3 font-medium">When</th>
                <th className="p-3 font-medium">Kind</th>
                <th className="p-3 font-medium">Sheet</th>
                <th className="p-3 font-medium">Duration</th>
                <th className="p-3 font-medium">Rows +/~/−</th>
                <th className="p-3 font-medium">Embed</th>
                <th className="p-3 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isEmbed = r.sheet_url?.startsWith("embed-backfill://");
                return (
                  <tr key={r.id} className="border-t">
                    <td className="p-3 text-muted-foreground whitespace-nowrap">
                      {new Date(r.fetched_at).toLocaleString()}
                    </td>
                    <td className="p-3">
                      <Badge variant={isEmbed ? "secondary" : "outline"}>{isEmbed ? "embed" : "refresh"}</Badge>
                    </td>
                    <td className="p-3 max-w-xs truncate" title={r.project_label ?? r.project_id}>
                      {r.project_label ?? r.project_id}
                    </td>
                    <td className="p-3">{isEmbed ? (r.embed_ms ?? "—") : (r.fetch_ms ?? "—")}ms</td>
                    <td className="p-3 whitespace-nowrap">
                      {isEmbed ? "—" : `${r.rows_added ?? 0} / ${r.rows_changed ?? 0} / ${r.rows_removed ?? 0}`}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {isEmbed ? `${r.embed_embedded ?? 0} embedded, ${r.embed_remaining ?? 0} left` : "—"}
                    </td>
                    <td className="p-3 text-xs max-w-md truncate" title={r.error ?? r.warning ?? ""}>
                      {r.error ? <span className="text-destructive">{r.error}</span> : (r.warning ?? "—")}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && !q.isLoading && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No audit rows yet — cron will populate this table on the next run.</td></tr>
              )}
              {q.isLoading && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        DB CPU/WAL impact is dominated by non-unchanged runs. A high "unchanged" ratio means the content-hash short-circuit is doing its job and cron is basically free.
      </p>
    </div>
  );
}

function summarize(rows: SyncAuditRow[]) {
  const refresh = rows.filter((r) => !r.sheet_url?.startsWith("embed-backfill://"));
  const embed = rows.filter((r) => r.sheet_url?.startsWith("embed-backfill://"));
  const unchanged = refresh.filter((r) => (r.warning ?? "").includes("unchanged")).length;
  const errors = rows.filter((r) => r.error).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length ? Math.round(sum(xs) / xs.length) : 0);
  return {
    refreshRuns: refresh.length,
    unchanged,
    unchangedPct: refresh.length ? Math.round((unchanged / refresh.length) * 100) : 0,
    avgFetchMs: avg(refresh.map((r) => r.fetch_ms ?? 0).filter((n) => n > 0)),
    rowsChangedSum: sum(refresh.map((r) => (r.rows_added ?? 0) + (r.rows_changed ?? 0) + (r.rows_removed ?? 0))),
    embedRuns: embed.length,
    embeddedSum: sum(embed.map((r) => r.embed_embedded ?? 0)),
    avgEmbedMs: avg(embed.map((r) => r.embed_ms ?? 0).filter((n) => n > 0)),
    errors,
  };
}

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: string; tone?: "danger" }) {
  const color = tone === "danger" ? "text-destructive" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground mb-1">{label}</div>
        <div className={`text-2xl font-semibold ${color}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}
