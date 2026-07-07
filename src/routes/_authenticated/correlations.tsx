// Correlations dashboard. Left: entity picker (typeahead). Right: four buckets
// of matches for the selected focus entity.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { z } from "zod";
import {
  getCorrelations,
  listCorrelationEntities,
  type CorrelationBuckets,
  type CorrelationItem,
  type CorrelationRef,
  type PickerEntity,
} from "@/lib/correlations.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Network, Rows3, GitBranch, FolderKanban, Sparkles, Loader2,
  Bot, FolderTree, User, Rows, ArrowLeft, ExternalLink,
} from "lucide-react";

type Focus = { kind: "activity" | "sheet_row" | "project" | "person"; id: string; rowIndex?: number; label?: string };

const searchSchema = z.object({
  kind: z.enum(["activity", "sheet_row", "project", "person"]).optional(),
  id: z.string().optional(),
  rowIndex: z.number().optional(),
});

const BUCKETS: Array<{
  key: keyof CorrelationBuckets;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = [
  { key: "crossSheet", label: "Cross-sheet rows", icon: Rows3, description: "Rows in other sheets that share this activity or owner." },
  { key: "crossTask", label: "Cross-task links", icon: GitBranch, description: "Predecessors, successors, or siblings of the focus task." },
  { key: "crossProject", label: "Cross-project", icon: FolderKanban, description: "Other projects where the same person appears." },
  { key: "semantic", label: "Semantic matches", icon: Sparkles, description: "Nearest neighbors by AI similarity, when exact matches are thin." },
];

const KIND_ICON: Record<Focus["kind"], React.ComponentType<{ className?: string }>> = {
  activity: Bot, sheet_row: Rows, project: FolderTree, person: User,
};

function refToLink(ref: CorrelationRef): { to: string; params?: Record<string, string> } {
  switch (ref.kind) {
    case "activity": return { to: "/agent/activity" };
    case "project": return { to: "/agent/project/$projectId", params: { projectId: ref.id } };
    case "sheet_row": return { to: "/sheets/$sheetId", params: { sheetId: ref.sheetRegistryId } };
    case "person": return { to: "/agent/person/$key", params: { key: ref.id } };
  }
}

function ItemRow({ item, onFocus }: { item: CorrelationItem; onFocus: (f: Focus) => void }) {
  const link = refToLink(item.ref);
  return (
    <div className="rounded-md border p-2 hover:bg-muted/40 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{item.label}</div>
          {item.subtitle && <div className="text-[11px] text-muted-foreground truncate">{item.subtitle}</div>}
          <div className="text-[10px] text-muted-foreground italic mt-0.5">{item.why}</div>
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
      <div className="flex gap-3 mt-2 text-[11px]">
        <button
          onClick={() => {
            if (item.ref.kind === "sheet_row") {
              onFocus({ kind: "sheet_row", id: item.ref.sheetRegistryId, rowIndex: item.ref.rowIndex, label: item.label });
            } else if (item.ref.kind === "activity") {
              onFocus({ kind: "activity", id: item.ref.id, label: item.label });
            } else if (item.ref.kind === "project") {
              onFocus({ kind: "project", id: item.ref.id, label: item.label });
            } else {
              onFocus({ kind: "person", id: item.ref.id, label: item.label });
            }
          }}
          className="text-primary hover:underline"
        >
          Explore this →
        </button>
        <Link to={link.to as never} params={link.params as never}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}

function EntityPicker({ onFocus }: { onFocus: (f: Focus) => void }) {
  const call = useServerFn(listCorrelationEntities);
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, isFetching } = useQuery({
    queryKey: ["correlation-picker", debounced],
    queryFn: () => call({ data: { query: debounced } }),
    enabled: debounced.length > 0,
    staleTime: 30_000,
  });

  const grouped = useMemo(() => {
    const g: Record<Focus["kind"], PickerEntity[]> = { activity: [], sheet_row: [], project: [], person: [] };
    for (const e of (data ?? []) as PickerEntity[]) g[e.kind].push(e);
    return g;
  }, [data]);

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Focus entity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          placeholder="Search activities, projects, rows, people…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        {isFetching && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Searching…
          </div>
        )}
        {debounced && !isFetching && (data?.length ?? 0) === 0 && (
          <div className="text-xs text-muted-foreground italic">No matches.</div>
        )}
        {(Object.keys(grouped) as Focus["kind"][]).map((kind) => {
          if (grouped[kind].length === 0) return null;
          const Icon = KIND_ICON[kind];
          return (
            <div key={kind}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1">
                <Icon className="h-3 w-3" /> {kind.replace("_", " ")}
              </div>
              <div className="space-y-1">
                {grouped[kind].map((e) => (
                  <button
                    key={`${kind}:${e.id}`}
                    onClick={() => onFocus({
                      kind,
                      id: kind === "sheet_row" ? e.meta!.sheetRegistryId! : e.id,
                      rowIndex: kind === "sheet_row" ? e.meta!.rowIndex : undefined,
                      label: e.label,
                    })}
                    className="w-full text-left rounded-md border p-2 hover:bg-muted/50 transition-colors"
                  >
                    <div className="text-sm truncate">{e.label}</div>
                    {e.subtitle && <div className="text-[11px] text-muted-foreground truncate">{e.subtitle}</div>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function BucketPanel({ bucket, items, onFocus }: {
  bucket: typeof BUCKETS[number];
  items: CorrelationItem[];
  onFocus: (f: Focus) => void;
}) {
  const Icon = bucket.icon;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          {bucket.label}
          <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
        </CardTitle>
        <div className="text-[11px] text-muted-foreground">{bucket.description}</div>
      </CardHeader>
      <CardContent className="pt-0 space-y-1.5">
        {items.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-2 text-center">
            No results in this bucket.
          </div>
        ) : (
          items.map((item, i) => <ItemRow key={i} item={item} onFocus={onFocus} />)
        )}
      </CardContent>
    </Card>
  );
}

function CorrelationsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [focus, setFocus] = useState<Focus | null>(
    search.kind && search.id ? { kind: search.kind, id: search.id, rowIndex: search.rowIndex } : null,
  );

  const call = useServerFn(getCorrelations);
  const { data, isLoading, error } = useQuery({
    queryKey: ["correlations", focus?.kind, focus?.id, focus?.rowIndex ?? null],
    queryFn: () => call({ data: { kind: focus!.kind, id: focus!.id, rowIndex: focus!.rowIndex } }),
    enabled: !!focus,
    staleTime: 60_000,
  });

  const handleFocus = (f: Focus) => {
    setFocus(f);
    navigate({ search: { kind: f.kind, id: f.id, rowIndex: f.rowIndex } });
  };

  const buckets = data ?? { crossSheet: [], crossTask: [], crossProject: [], semantic: [] };
  const totalMatches = Object.values(buckets).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/agent" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Network className="h-5 w-5 text-primary" />
            Correlations
          </h1>
          <p className="text-sm text-muted-foreground">
            Find every place a task, row, project, or person shows up — with exact matches first, semantic fallback.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        <EntityPicker onFocus={handleFocus} />

        <div className="space-y-3">
          {!focus ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                Pick a focus entity on the left to see its correlations across the workspace.
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="py-3 flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Focus</div>
                    <div className="text-sm font-medium truncate">{focus.label ?? focus.id}</div>
                    <div className="text-[11px] text-muted-foreground">{focus.kind.replace("_", " ")}</div>
                  </div>
                  <Badge variant="outline" className="text-[10px]">{totalMatches} matches</Badge>
                </CardContent>
              </Card>

              {isLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" /> Correlating…
                </div>
              ) : error ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {error instanceof Error ? error.message : "Failed to load"}
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {BUCKETS.map((b) => (
                    <BucketPanel key={b.key} bucket={b} items={buckets[b.key]} onFocus={handleFocus} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/correlations")({
  head: () => ({ meta: [{ title: "Correlations — DelayLens" }] }),
  validateSearch: (raw) => searchSchema.parse(raw),
  component: CorrelationsPage,
});
