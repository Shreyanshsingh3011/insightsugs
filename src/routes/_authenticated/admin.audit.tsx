import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useIsAdmin } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";

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

function DetailRow({ entry }: { entry: Entry }) {
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
            <span className="text-xs text-muted-foreground">
              Project · {entry.project_id.slice(0, 8)}
            </span>
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

  if (!isAdmin) return <div className="mx-auto max-w-5xl px-4 py-8 text-muted-foreground">Admins only.</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Audit Log</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Recent system events across projects and users.
      </p>
      <Card className="mt-6 divide-y divide-border/60 overflow-hidden">
        {isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && data?.length === 0 && (
          <p className="p-6 text-sm text-muted-foreground">No events yet.</p>
        )}
        {data?.map((e) => <DetailRow key={e.id} entry={e} />)}
      </Card>
    </div>
  );
}
