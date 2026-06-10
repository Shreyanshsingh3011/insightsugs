import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getMyDependentActivities } from "@/lib/sheets.functions";
import { ListChecks, ExternalLink, Lock, ChevronRight } from "lucide-react";

type Row = {
  sheet_id: string;
  sheet_name: string;
  row_index: number;
  activity: string;
  status: string | null;
  predecessor: string | null;
  matched_via: "email" | "name";
};

const COMPLETED_STATUSES = new Set([
  "done", "completed", "complete", "closed", "cleared",
  "approved", "finished", "resolved",
]);

function isCleared(status: string | null | undefined): boolean {
  if (!status) return false;
  return COMPLETED_STATUSES.has(status.trim().toLowerCase());
}

export function MyDependentActivities() {
  const fetchFn = useServerFn(getMyDependentActivities);
  const { data, isLoading, error } = useQuery({
    queryKey: ["my-dependent-activities"],
    queryFn: () => fetchFn(),
  });
  const [selected, setSelected] = useState<Row | null>(null);

  const rows = (data?.rows ?? []) as Row[];

  // Build a map: activity name → its row, to check predecessor status.
  const byActivity = new Map(
    rows.map((r) => [r.activity.trim().toLowerCase(), r]),
  );

  const enriched = rows.map((r) => {
    const predRow = r.predecessor
      ? byActivity.get(r.predecessor.trim().toLowerCase())
      : null;
    const predStatus = predRow?.status ?? null;
    const blocked = !!r.predecessor && !isCleared(predStatus);
    return { ...r, predStatus, blocked };
  });

  return (
    <Card className="mt-6 border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ListChecks className="h-4 w-4 text-primary" />
          My dependent activities
        </div>
        <span className="text-xs text-muted-foreground">
          {enriched.length} matched to you
        </span>
      </div>

      {isLoading && (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      )}
      {error && (
        <p className="py-6 text-center text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load."}
        </p>
      )}
      {!isLoading && !error && enriched.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No activities matched your email or name on registered sheets.
        </p>
      )}

      {enriched.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Activity</th>
                <th className="px-2 py-2">Predecessor</th>
                <th className="px-2 py-2">Predecessor status</th>
                <th className="px-2 py-2">My status</th>
                <th className="px-2 py-2">Source</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {enriched.map((r) => {
                const rowClass = r.blocked
                  ? "cursor-not-allowed opacity-50"
                  : "cursor-pointer hover:bg-muted/40";
                return (
                  <tr
                    key={`${r.sheet_id}-${r.row_index}`}
                    className={`border-t border-border ${rowClass}`}
                    onClick={() => {
                      if (!r.blocked) setSelected(r);
                    }}
                    title={
                      r.blocked
                        ? "Locked until the predecessor activity is cleared"
                        : "Click to view dependency details"
                    }
                  >
                    <td className="px-2 py-2 font-medium">{r.activity}</td>
                    <td className="px-2 py-2">{r.predecessor ?? "—"}</td>
                    <td className="px-2 py-2">
                      {r.predecessor ? (
                        <Badge variant={isCleared(r.predStatus) ? "default" : "outline"}>
                          {r.predStatus ?? "unknown"}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <Badge variant="outline">{r.status ?? "—"}</Badge>
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {r.sheet_name}
                    </td>
                    <td className="px-2 py-2">
                      {r.blocked ? (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <DependencyDetailsDialog
        row={selected}
        onClose={() => setSelected(null)}
      />
    </Card>
  );
}

function DependencyDetailsDialog({
  row,
  onClose,
}: {
  row: Row | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!row} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Dependency details</DialogTitle>
        </DialogHeader>
        {row && (
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase text-muted-foreground">Activity</div>
              <div className="font-medium">{row.activity}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Predecessor</div>
              <div>{row.predecessor ?? "None"}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">My status</div>
              <Badge variant="outline">{row.status ?? "—"}</Badge>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Matched via</div>
              <Badge variant="outline">{row.matched_via}</Badge>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Source sheet</div>
              <Link
                to="/sheets/$sheetId"
                params={{ sheetId: row.sheet_id }}
                className="inline-flex items-center gap-1 text-primary hover:underline"
                onClick={onClose}
              >
                {row.sheet_name} <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
