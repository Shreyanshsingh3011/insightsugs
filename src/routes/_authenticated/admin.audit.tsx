import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useMemo } from "react";
import { ExternalLink, Eye } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/audit")({
  head: () => ({ meta: [{ title: "Audit Log — DelayLens" }] }),
  component: AuditPage,
});

type Entry = {
  id: string;
  actor_id: string | null;
  project_id: string | null;
  activity_id: string | null;
  event_type: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

function humanizeEventType(t: string) {
  return t
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") {
    // ISO date detection
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:/.test(v)) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) return d.toLocaleString();
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "none";
    if (v.every((x) => typeof x === "string" || typeof x === "number")) return v.join(", ");
    return `${v.length} item${v.length === 1 ? "" : "s"}`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    return keys.length ? `${keys.length} field${keys.length === 1 ? "" : "s"}` : "—";
  }
  return String(v);
}

function humanizeKey(k: string) {
  return k.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function DetailRow({ entry, projectName }: { entry: Entry; projectName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const details = entry.details ?? {};
  const keys = Object.keys(details);

  return (
    <div className="grid grid-cols-[170px_1fr] gap-4 p-4 text-sm hover:bg-muted/30 transition-colors">
      <div className="text-xs text-muted-foreground">
        {new Date(entry.created_at).toLocaleString()}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="font-medium">
            {humanizeEventType(entry.event_type)}
          </Badge>
          {entry.project_id && (
            <Link
              to="/agent/project/$projectId"
              params={{ projectId: entry.project_id }}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {projectName ?? `Project · ${entry.project_id.slice(0, 8)}`}
            </Link>
          )}
          {entry.actor_id && (
            <span className="text-xs text-muted-foreground">
              Actor · {entry.actor_id.slice(0, 8)}
            </span>
          )}
        </div>
        {keys.length > 0 && (
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
            {keys.slice(0, expanded ? keys.length : 6).map((k) => (
              <div key={k} className="flex gap-2 text-xs">
                <span className="text-muted-foreground min-w-0 truncate">{humanizeKey(k)}:</span>
                <span className="text-foreground truncate" title={formatValue((details as Record<string, unknown>)[k])}>
                  {formatValue((details as Record<string, unknown>)[k])}
                </span>
              </div>
            ))}
            {keys.length > 6 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="text-xs text-primary hover:underline text-left col-span-full mt-1"
              >
                {expanded ? "Show less" : `Show ${keys.length - 6} more`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AuditPage() {
  const isAdmin = useIsAdmin();
  const { data, isLoading } = useQuery({
    queryKey: ["audit_log"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_log").select("*").order("created_at", { ascending: false }).limit(200);
      if (error) throw error;
      return data as Entry[];
    },
  });

  const { data: syncs, isLoading: syncsLoading } = useQuery({
    queryKey: ["sheet_sync_audit"],
    enabled: isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sheet_sync_audit")
        .select("*")
        .order("fetched_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as SyncEntry[];
    },
  });

  const projectIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...((data ?? []).map((e) => e.project_id).filter(Boolean) as string[]),
          ...((syncs ?? []).map((s) => s.project_id).filter(Boolean) as string[]),
        ]),
      ),
    [data, syncs],
  );

  const { data: projects } = useQuery({
    queryKey: ["audit_log_projects", projectIds],
    enabled: isAdmin && projectIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects").select("id,name").in("id", projectIds);
      if (error) throw error;
      return data as { id: string; name: string }[];
    },
  });

  const projectNameMap = useMemo(() => {
    const m = new Map<string, string>();
    (projects ?? []).forEach((p) => m.set(p.id, p.name));
    return m;
  }, [projects]);

  // Latest successful sync per project (most recent, no error)
  const latestByProject = useMemo(() => {
    const map = new Map<string, SyncEntry>();
    (syncs ?? []).forEach((s) => {
      if (s.error) return;
      if (!map.has(s.project_id)) map.set(s.project_id, s);
    });
    return Array.from(map.values());
  }, [syncs]);

  if (!isAdmin) return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Admins only.</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Latest Sync Impact</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What changed in each project since the last successful fetch.
        </p>
        <Card className="mt-4 divide-y divide-border/60 overflow-hidden">
          {syncsLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
          {!syncsLoading && latestByProject.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No successful syncs yet.</p>
          )}
          {latestByProject.map((s) => {
            const added = s.rows_added ?? 0;
            const changed = s.rows_changed ?? 0;
            const removed = s.rows_removed ?? 0;
            const name = projectNameMap.get(s.project_id) ?? s.project_label ?? `Project · ${s.project_id.slice(0, 8)}`;
            return (
              <div key={s.project_id} className="flex items-center justify-between gap-4 p-4 text-sm hover:bg-muted/30 transition-colors">
                <div className="min-w-0 flex-1">
                  <Link
                    to="/agent/project/$projectId"
                    params={{ projectId: s.project_id }}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {name}
                  </Link>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Last fetch {new Date(s.fetched_at).toLocaleString()}
                    {s.tab_name ? ` · Tab ${s.tab_name}` : ""}
                    {s.rows_total != null ? ` · ${s.rows_total} rows total` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 text-xs shrink-0">
                  {added + changed + removed === 0 ? (
                    <span className="rounded bg-muted text-muted-foreground px-2 py-0.5">No changes</span>
                  ) : (
                    <>
                      {added > 0 && (
                        <span className="rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5">+{added} added</span>
                      )}
                      {changed > 0 && (
                        <span className="rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5">~{changed} changed</span>
                      )}
                      {removed > 0 && (
                        <span className="rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 px-2 py-0.5">−{removed} removed</span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sheet Sync Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What each fetch picked up from Google Sheets — rows added, changed, removed, and embeddings rebuilt.
        </p>
        <Card className="mt-4 divide-y divide-border/60 overflow-hidden">
          {syncsLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
          {!syncsLoading && syncs?.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No sync activity yet.</p>
          )}
          {syncs?.map((s) => (
            <SyncRow
              key={s.id}
              sync={s}
              projectName={projectNameMap.get(s.project_id)}
            />
          ))}
        </Card>
      </div>

      <div>
        <h2 className="text-xl font-semibold tracking-tight">System Events</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Recent system events across projects and users.
        </p>
        <Card className="mt-4 divide-y divide-border/60 overflow-hidden">
          {isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && data?.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No events yet.</p>
          )}
          {data?.map((e) => (
            <DetailRow
              key={e.id}
              entry={e}
              projectName={e.project_id ? projectNameMap.get(e.project_id) : undefined}
            />
          ))}
        </Card>
      </div>
    </div>
  );
}

type SyncEntry = {
  id: string;
  project_id: string;
  project_label: string | null;
  sheet_url: string;
  tab_name: string | null;
  trigger_kind: string;
  fetched_at: string;
  fetch_ms: number | null;
  rows_total: number | null;
  rows_added: number | null;
  rows_removed: number | null;
  rows_changed: number | null;
  changed_columns: string[] | null;
  changed_row_indexes: number[] | null;
  embed_embedded: number | null;
  embed_refreshed: number | null;
  embed_remaining: number | null;
  embed_ms: number | null;
  warning: string | null;
  error: string | null;
};

function SyncRow({ sync, projectName }: { sync: SyncEntry; projectName?: string }) {
  const added = sync.rows_added ?? 0;
  const removed = sync.rows_removed ?? 0;
  const changed = sync.rows_changed ?? 0;
  const hasDelta = added + removed + changed > 0;
  const embedded = sync.embed_embedded ?? 0;
  const refreshed = sync.embed_refreshed ?? 0;
  const cols = sync.changed_columns ?? [];
  const rowIdx = sync.changed_row_indexes ?? [];

  return (
    <div className="grid grid-cols-[170px_1fr] gap-4 p-4 text-sm hover:bg-muted/30 transition-colors">
      <div className="text-xs text-muted-foreground">
        {new Date(sync.fetched_at).toLocaleString()}
        {sync.fetch_ms != null && (
          <div className="mt-0.5 text-[10px]">{sync.fetch_ms} ms fetch</div>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant={sync.error ? "destructive" : hasDelta ? "default" : "secondary"}>
            {sync.trigger_kind}
          </Badge>
          {sync.project_id && (
            <Link
              to="/agent/project/$projectId"
              params={{ projectId: sync.project_id }}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {projectName ?? sync.project_label ?? `Project · ${sync.project_id.slice(0, 8)}`}
            </Link>
          )}
          {sync.tab_name && (
            <span className="text-xs text-muted-foreground">Tab · {sync.tab_name}</span>
          )}
        </div>

        {sync.error ? (
          <div className="text-xs text-destructive">{sync.error}</div>
        ) : hasDelta ? (
          <div className="flex flex-wrap gap-3 text-xs">
            {added > 0 && (
              <span className="rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5">
                +{added} added
              </span>
            )}
            {changed > 0 && (
              <span className="rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5">
                ~{changed} changed
              </span>
            )}
            {removed > 0 && (
              <span className="rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 px-2 py-0.5">
                −{removed} removed
              </span>
            )}
            {sync.rows_total != null && (
              <span className="text-muted-foreground">Total {sync.rows_total} rows</span>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            No changes detected{sync.rows_total != null ? ` · ${sync.rows_total} rows scanned` : ""}
          </div>
        )}

        {(cols.length > 0 || rowIdx.length > 0 || hasDelta) && (
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {cols.length > 0 && (
              <span className="text-muted-foreground">
                {cols.length} column{cols.length === 1 ? "" : "s"} updated
              </span>
            )}
            {rowIdx.length > 0 && (
              <span className="text-muted-foreground">
                {rowIdx.length} row{rowIdx.length === 1 ? "" : "s"} indexed
              </span>
            )}
            <ChangedRowsDialog sync={sync} projectName={projectName} />
          </div>
        )}

        {(embedded > 0 || refreshed > 0 || sync.embed_ms) && (
          <div className="text-xs text-muted-foreground">
            Embeddings: {embedded} new, {refreshed} refreshed
            {sync.embed_remaining ? `, ${sync.embed_remaining} pending` : ""}
            {sync.embed_ms ? ` · ${sync.embed_ms} ms` : ""}
          </div>
        )}

        {sync.warning && (
          <div className="text-xs text-amber-600 dark:text-amber-400">{sync.warning}</div>
        )}
      </div>
    </div>
  );
}

function ChangedRowsDialog({ sync, projectName }: { sync: SyncEntry; projectName?: string }) {
  const added = sync.rows_added ?? 0;
  const changed = sync.rows_changed ?? 0;
  const removed = sync.rows_removed ?? 0;
  const cols = sync.changed_columns ?? [];
  const rowIdx = sync.changed_row_indexes ?? [];
  const label = projectName ?? sync.project_label ?? `Project · ${sync.project_id.slice(0, 8)}`;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
          <Eye className="h-3 w-3 mr-1" /> View changed rows
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Changed rows — {label}</DialogTitle>
          <DialogDescription>
            Fetched {new Date(sync.fetched_at).toLocaleString()}
            {sync.tab_name ? ` · Tab ${sync.tab_name}` : ""}
            {sync.rows_total != null ? ` · ${sync.rows_total} rows total` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5">+{added} added</span>
          <span className="rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5">~{changed} changed</span>
          <span className="rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 px-2 py-0.5">−{removed} removed</span>
        </div>

        <div className="space-y-3">
          <section>
            <h3 className="text-sm font-medium mb-1.5">Changed columns ({cols.length})</h3>
            {cols.length === 0 ? (
              <p className="text-xs text-muted-foreground">None</p>
            ) : (
              <ScrollArea className="max-h-40 rounded-md border p-2">
                <div className="flex flex-wrap gap-1.5">
                  {cols.map((c) => (
                    <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                  ))}
                </div>
              </ScrollArea>
            )}
          </section>

          <section>
            <h3 className="text-sm font-medium mb-1.5">Row indexes ({rowIdx.length})</h3>
            {rowIdx.length === 0 ? (
              <p className="text-xs text-muted-foreground">None</p>
            ) : (
              <ScrollArea className="max-h-56 rounded-md border p-2">
                <div className="flex flex-wrap gap-1">
                  {rowIdx.map((n) => (
                    <span key={n} className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">
                      #{n}
                    </span>
                  ))}
                </div>
              </ScrollArea>
            )}
          </section>

          {(added > 0 || removed > 0) && (
            <p className="text-xs text-muted-foreground">
              Note: added and removed row positions are inferred from the fetch delta (rows appended/truncated at the end of the sheet); only in-place edits are tracked as explicit row indexes.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


