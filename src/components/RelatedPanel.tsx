// Reusable "Related" side panel. Drop into any detail view to show the top N
// correlations for that entity across four buckets (cross-sheet, cross-task,
// cross-project, semantic).
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { getCorrelations, type CorrelationItem, type CorrelationRef } from "@/lib/correlations.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Rows3, GitBranch, FolderKanban, Sparkles, ExternalLink, Network } from "lucide-react";

type BucketKey = "crossSheet" | "crossTask" | "crossProject" | "semantic";

const BUCKET_META: Record<BucketKey, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  crossSheet: { label: "Cross-sheet rows", icon: Rows3 },
  crossTask: { label: "Cross-task links", icon: GitBranch },
  crossProject: { label: "Cross-project", icon: FolderKanban },
  semantic: { label: "Semantic matches", icon: Sparkles },
};

function refToLink(ref: CorrelationRef): { to: string; params?: Record<string, string> } {
  switch (ref.kind) {
    case "activity":
      return { to: "/agent/activity", params: {} };
    case "project":
      return { to: "/agent/project/$projectId", params: { projectId: ref.id } };
    case "sheet_row":
      return { to: "/sheets/$sheetId", params: { sheetId: ref.sheetRegistryId } };
    case "person":
      return { to: "/agent/person/$key", params: { key: ref.id } };
  }
}

function Row({ item }: { item: CorrelationItem }) {
  const link = refToLink(item.ref);
  return (
    <Link
      to={link.to as never}
      params={link.params as never}
      className="block rounded-md border p-2 hover:bg-muted/50 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{item.label}</div>
          {item.subtitle && <div className="text-[11px] text-muted-foreground truncate">{item.subtitle}</div>}
          <div className="text-[10px] text-muted-foreground mt-0.5 italic">{item.why}</div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Badge variant={item.matchType === "exact" ? "default" : "secondary"} className="text-[10px]">
            {item.matchType}
          </Badge>
          {item.score !== null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {(item.score * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function RelatedPanel({
  entityKind,
  entityId,
  rowIndex,
  focusLabel,
  limitPerBucket = 5,
}: {
  entityKind: "activity" | "sheet_row" | "project" | "person";
  entityId: string;
  rowIndex?: number;
  focusLabel?: string;
  limitPerBucket?: number;
}) {
  const call = useServerFn(getCorrelations);
  const [tab, setTab] = useState<BucketKey>("crossSheet");
  const { data, isLoading, error } = useQuery({
    queryKey: ["correlations", entityKind, entityId, rowIndex ?? null],
    queryFn: () => call({ data: { kind: entityKind, id: entityId, rowIndex } }),
    staleTime: 60_000,
  });

  const buckets = data ?? { crossSheet: [], crossTask: [], crossProject: [], semantic: [] };
  const active = buckets[tab].slice(0, limitPerBucket);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            <Network className="h-4 w-4 text-primary" /> Related
          </CardTitle>
          <Link to="/correlations" search={{ kind: entityKind, id: entityId, rowIndex } as never}
                className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            See all <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        {focusLabel && <div className="text-[11px] text-muted-foreground truncate">Focus: {focusLabel}</div>}
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="flex gap-1 rounded-md border p-1 text-[11px] overflow-x-auto">
          {(Object.keys(BUCKET_META) as BucketKey[]).map((k) => {
            const Icon = BUCKET_META[k].icon;
            const count = buckets[k].length;
            return (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded whitespace-nowrap ${tab === k ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                <Icon className="h-3 w-3" />
                {BUCKET_META[k].label}
                {count > 0 && <span className="text-[10px] opacity-70">({count})</span>}
              </button>
            );
          })}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs py-4">
            <Loader2 className="h-3 w-3 animate-spin" /> Finding correlations…
          </div>
        ) : error ? (
          <div className="text-xs text-destructive">{error instanceof Error ? error.message : "Failed"}</div>
        ) : active.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-2 text-center">
            No {BUCKET_META[tab].label.toLowerCase()} for this entity.
          </div>
        ) : (
          <div className="space-y-1.5">
            {active.map((item, i) => <Row key={i} item={item} />)}
            {buckets[tab].length > limitPerBucket && (
              <Link to="/correlations" search={{ kind: entityKind, id: entityId, rowIndex } as never}>
                <Button variant="ghost" size="sm" className="w-full text-xs">
                  See all {buckets[tab].length} in Correlations →
                </Button>
              </Link>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
