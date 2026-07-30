// Mismatch inspector — reviews the cross-verification reports recorded by every
// dashboard destination page (KPI drilldowns, project/person/stage/row pages).
// It shows which cards disagree with the dashboard snapshot, which fields drift
// on shared rows, and the canonical rows each destination page actually used.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, RefreshCw, Trash2, Fingerprint } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  clearConsistencyReports,
  readConsistencyReports,
  readDashboardSnapshot,
  type ConsistencyReport,
  type DashboardSnapshot,
} from "@/lib/dashboard-consistency";

export const Route = createFileRoute("/_authenticated/agent/mismatch-inspector")({
  head: () => ({
    meta: [
      { title: "Mismatch inspector — dashboard parity" },
      { name: "description", content: "Compare dashboard cards with detail pages: mismatched fields, missing rows, and the canonical rows used on each destination page." },
      { property: "og:title", content: "Mismatch inspector — dashboard parity" },
      { property: "og:description", content: "Compare dashboard cards with detail pages: mismatched fields, missing rows, and canonical rows per destination." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MismatchInspectorPage,
});

function pathFor(report: ConsistencyReport): string {
  return report.path || "/agent";
}

function MismatchInspectorPage() {
  const [reports, setReports] = useState<ConsistencyReport[]>([]);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setReports(readConsistencyReports());
    setSnapshot(readDashboardSnapshot());
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("agent:consistency-reports", handler);
    return () => window.removeEventListener("agent:consistency-reports", handler);
  }, [refresh]);

  const failing = useMemo(() => reports.filter((r) => r.available && !r.ok), [reports]);
  const passing = useMemo(() => reports.filter((r) => r.available && r.ok), [reports]);
  const open = useMemo(() => reports.find((r) => r.id === openId) ?? null, [reports, openId]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 md:py-8 space-y-6" data-testid="mismatch-inspector">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Mismatch inspector</h1>
          <p className="text-sm text-muted-foreground">
            Cross-verification of every dashboard destination page against the dashboard snapshot.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { clearConsistencyReports(); refresh(); }}>
            <Trash2 className="h-4 w-4" /> Clear
          </Button>
          <Button size="sm" asChild>
            <Link to="/agent">Back to dashboard</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Fingerprint className="h-4 w-4" aria-hidden /> Dashboard snapshot
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {snapshot ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground" data-testid="snapshot-summary">
              <span>Scope: <span className="text-foreground font-medium">{snapshot.scopeLabel || "All"}</span></span>
              <span>Rows: <span className="text-foreground font-medium tabular-nums">{snapshot.rowCount}</span></span>
              <span>Signature: <span className="text-foreground font-mono text-xs">{snapshot.signature}</span></span>
              <span>Saved: <span className="text-foreground">{new Date(snapshot.savedAt).toLocaleString()}</span></span>
            </div>
          ) : (
            <p className="text-muted-foreground">
              No snapshot yet — open the <Link to="/agent" className="underline">dashboard</Link> once, then click through its cards.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Pages checked" value={reports.length} />
        <Stat label="Mismatched" value={failing.length} tone={failing.length ? "bad" : "ok"} />
        <Stat label="Verified" value={passing.length} tone="ok" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Destination pages</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reports.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No verification reports recorded in this session yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead className="text-right">Dashboard</TableHead>
                  <TableHead className="text-right">Page</TableHead>
                  <TableHead className="text-right">Field diffs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...failing, ...passing].map((r) => (
                  <TableRow key={r.id} data-testid="report-row" data-ok={r.ok ? "1" : "0"}>
                    <TableCell className="font-medium">
                      <Link to={pathFor(r)} className="hover:underline">{r.targetLabel}</Link>
                      <div className="text-xs text-muted-foreground">{r.path}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.expectedCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.actualCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.fieldDiffs.length}</TableCell>
                    <TableCell>
                      {r.ok ? (
                        <Badge variant="outline" className="text-emerald-700 border-emerald-500/30 bg-emerald-500/10">
                          <CheckCircle2 className="h-3 w-3" /> Verified
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-rose-700 border-rose-500/30 bg-rose-500/10">
                          <AlertTriangle className="h-3 w-3" /> Mismatch
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                        {openId === r.id ? "Hide" : "Inspect"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {open && (
        <Card data-testid="report-detail">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{open.targetLabel}</CardTitle>
            <p className="text-xs text-muted-foreground">{open.message}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <section className="space-y-2">
              <h2 className="text-sm font-medium">Disagreeing fields</h2>
              {open.fieldDiffs.length === 0 ? (
                <p className="text-sm text-muted-foreground">All shared rows match field-for-field.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Field</TableHead>
                      <TableHead>Dashboard</TableHead>
                      <TableHead>Detail page</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {open.fieldDiffs.map((d, i) => (
                      <TableRow key={`${d.key}-${d.field}-${i}`}>
                        <TableCell className="text-xs">{d.label}</TableCell>
                        <TableCell className="font-mono text-xs">{d.field}</TableCell>
                        <TableCell className="text-xs">{d.expected}</TableCell>
                        <TableCell className="text-xs text-rose-700">{d.actual}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <KeyList title={`Missing on page (${open.missingKeys.length})`} keys={open.missingKeys} rows={open.canonicalRows} />
              <KeyList title={`Extra on page (${open.extraKeys.length})`} keys={open.extraKeys} rows={open.actualRows} />
            </section>

            <section className="space-y-2">
              <h2 className="text-sm font-medium">Canonical rows used ({open.canonicalRows.length})</h2>
              <div className="max-h-80 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project</TableHead>
                      <TableHead>Activity</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Bucket</TableHead>
                      <TableHead className="text-right">TAT</TableHead>
                      <TableHead className="text-right">Taken</TableHead>
                      <TableHead className="text-right">Delay</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {open.canonicalRows.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="text-xs">{r.project || "—"}</TableCell>
                        <TableCell className="text-xs">{r.activity || "—"}</TableCell>
                        <TableCell className="text-xs">{r.person || "—"}</TableCell>
                        <TableCell className="text-xs">{r.stage || "—"}</TableCell>
                        <TableCell className="text-xs">{r.bucket}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{r.tat}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{r.taken}</TableCell>
                        <TableCell className="text-xs text-right tabular-nums">{r.delay}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-rose-600" : tone === "ok" ? "text-emerald-600" : ""}`}>
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function KeyList({ title, keys, rows }: { title: string; keys: string[]; rows: { key: string; project: string; activity: string }[] }) {
  const byKey = new Map(rows.map((r) => [r.key, `${r.project} · ${r.activity}`]));
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {keys.slice(0, 25).map((k, i) => (
            <li key={`${k}-${i}`} className="truncate">{byKey.get(k) ?? k}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
