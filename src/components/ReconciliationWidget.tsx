import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, TrendingDown } from "lucide-react";
import { computeReconciliationForUser } from "@/lib/reconciliation.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

export default function ReconciliationWidget({ sheetIds }: { sheetIds?: string[] }) {
  const run = useServerFn(computeReconciliationForUser);
  const query = useQuery({
    queryKey: ["reconciliation-widget", sheetIds ?? []],
    queryFn: () => run({ data: { sheetIds } }),
    staleTime: 60_000,
  });

  if (query.isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingDown className="h-4 w-4" /> Reconciliation
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Computing planned vs consumed…
        </CardContent>
      </Card>
    );
  }

  const data = query.data;
  if (!data?.summary) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingDown className="h-4 w-4" /> Reconciliation
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No reconciliation-shaped sheet found. Upload a sheet with{" "}
          <code className="rounded bg-muted px-1">planned_qty</code> plus{" "}
          <code className="rounded bg-muted px-1">consumed_qty</code> or{" "}
          <code className="rounded bg-muted px-1">received_qty</code>.
        </CardContent>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <TrendingDown className="h-4 w-4" /> Reconciliation
          {data.sheetLabel && (
            <Badge variant="outline" className="text-[10px]">{data.sheetLabel}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Metric label="Planned" value={fmt(s.totalPlanned)} />
          <Metric label="Consumed" value={fmt(s.totalConsumed || s.totalReceived)} />
          <Metric label="Net discrepancy" value={fmt(s.netDiscrepancy)} tone={s.netDiscrepancy !== 0 ? "warn" : undefined} />
          <Metric label="Rows w/ variance" value={`${s.rowsWithDiscrepancy}/${s.rowsScanned}`} />
        </div>

        {s.derivedFields.length > 0 && (
          <div className="rounded-md border border-dashed border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Derived:</span>{" "}
            {s.derivedFields.join(" · ")}
          </div>
        )}
        {s.missingColumns.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Missing columns: <strong>{s.missingColumns.join(", ")}</strong>. Some rows could not be
              reconciled from current data.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <BucketList title="By status" items={s.byStatus} />
          <BucketList title="By time bucket" items={s.byTimeBucket} />
          <BucketList title="Top delay reasons" items={s.topReasons} />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function BucketList({ title, items }: { title: string; items: { key: string; count: number; totalDiscrepancy: number }[] }) {
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="mb-1 text-xs font-medium">{title}</div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <ul className="space-y-1 text-xs">
          {items.slice(0, 6).map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-2">
              <span className="truncate">{b.key}</span>
              <span className="tabular-nums text-muted-foreground">
                {b.count} · {fmt(b.totalDiscrepancy)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
