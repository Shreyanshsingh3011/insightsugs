import { createFileRoute, Link } from "@tanstack/react-router";
import { useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { getSourcesHealth } from "@/lib/sources-health.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Clock, FileWarning, RefreshCw } from "lucide-react";

const sourcesHealthQuery = queryOptions({
  queryKey: ["admin", "sources-health"],
  queryFn: () => getSourcesHealth(),
  refetchInterval: 60_000,
});

export const Route = createFileRoute("/_authenticated/admin/sources-health")({
  head: () => ({
    meta: [
      { title: "Sources Health — Admin" },
      { name: "description", content: "Sheet sync and document embedding health diagnostic." },
      { name: "robots", content: "noindex" },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(sourcesHealthQuery),
  component: SourcesHealthPage,
});

function statusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "fresh" || status === "ok") return "default";
  if (status === "stale" || status === "missing-embeddings") return "secondary";
  if (status === "error" || status === "never-synced" || status === "no-chunks") return "destructive";
  return "outline";
}

function SourcesHealthPage() {
  const { data, refetch, isFetching } = useSuspenseQuery(sourcesHealthQuery);
  const s = data.summary;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sources Health</h1>
          <p className="text-sm text-muted-foreground">
            Diagnostic of every sheet's sync freshness and every document's embedding status. Refreshes automatically every 60s.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin">Back to Admin</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Sheets healthy" value={s.sheets_healthy} total={s.sheets_total} />
        <StatCard icon={<Clock className="h-4 w-4" />} label="Sheets stale (>6h)" value={s.sheets_stale} tone="warn" />
        <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Sheets broken" value={s.sheets_broken} tone="danger" />
        <StatCard icon={<FileWarning className="h-4 w-4" />} label="Docs w/o embeddings" value={s.documents_missing_embeddings} total={s.documents_total} tone="warn" />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Sheets ({data.sheets.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Rows</th>
                <th className="p-3 font-medium">Last sync</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.sheets.map((sheet) => (
                <tr key={sheet.id} className="border-t">
                  <td className="p-3 font-medium">{sheet.display_name}</td>
                  <td className="p-3 text-muted-foreground">{sheet.sheet_type ?? "—"}</td>
                  <td className="p-3">{sheet.row_count ?? 0}</td>
                  <td className="p-3 text-muted-foreground">
                    {sheet.hours_since_sync === null ? "never" : `${sheet.hours_since_sync}h ago`}
                  </td>
                  <td className="p-3"><Badge variant={statusColor(sheet.status)}>{sheet.status}</Badge></td>
                  <td className="p-3 text-xs text-destructive max-w-md truncate" title={sheet.last_error ?? ""}>{sheet.last_error ?? "—"}</td>
                </tr>
              ))}
              {data.sheets.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No sheets registered.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Documents ({data.documents.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Pages</th>
                <th className="p-3 font-medium">Chunks</th>
                <th className="p-3 font-medium">Embeddings</th>
                <th className="p-3 font-medium">Health</th>
              </tr>
            </thead>
            <tbody>
              {data.documents.map((doc) => (
                <tr key={doc.id} className="border-t">
                  <td className="p-3 font-medium max-w-xs truncate" title={doc.name}>{doc.name}</td>
                  <td className="p-3 text-muted-foreground">{doc.status ?? "—"}</td>
                  <td className="p-3">{doc.page_count ?? "—"}</td>
                  <td className="p-3">{doc.chunk_count}</td>
                  <td className="p-3">{doc.has_embeddings ? "✓" : "—"}</td>
                  <td className="p-3"><Badge variant={statusColor(doc.health)}>{doc.health}</Badge></td>
                </tr>
              ))}
              {data.documents.length === 0 && (
                <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No documents uploaded.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Generated at {new Date(data.generated_at).toLocaleString()}. Stale threshold: 6 hours.
      </p>
    </div>
  );
}

function StatCard({ icon, label, value, total, tone }: { icon: React.ReactNode; label: string; value: number; total?: number; tone?: "warn" | "danger" }) {
  const color = tone === "danger" ? "text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-500" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">{icon}<span>{label}</span></div>
        <div className={`text-2xl font-semibold ${color}`}>
          {value}{total !== undefined && <span className="text-sm text-muted-foreground font-normal"> / {total}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
