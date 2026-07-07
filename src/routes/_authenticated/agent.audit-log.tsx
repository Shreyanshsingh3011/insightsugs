import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAuditLog, type AuditEntry } from "@/lib/audit-log.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ScrollText, Loader2, Check, X, ArrowRight, MinusCircle, PlusCircle } from "lucide-react";

type FilterKey = "all" | "action" | "signup" | "approve" | "reject";

function DiffPanel({ label, data, tone }: {
  label: string; data: unknown; tone: "before" | "after";
}) {
  const obj = (data && typeof data === "object" && !Array.isArray(data))
    ? (data as Record<string, unknown>) : null;
  const empty = !obj || Object.keys(obj).length === 0;
  const Icon = tone === "after" ? PlusCircle : MinusCircle;
  return (
    <div className={`rounded-md border p-2 ${tone === "after" ? "border-emerald-500/40 bg-emerald-500/5" : "border-muted-foreground/20 bg-muted/30"}`}>
      <div className={`flex items-center gap-1.5 text-[11px] font-medium mb-1 ${tone === "after" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
        <Icon className="h-3 w-3" /> {label}
      </div>
      {empty ? (
        <div className="text-[11px] italic text-muted-foreground">— none —</div>
      ) : (
        <dl className="space-y-0.5">
          {Object.entries(obj!).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <dt className="text-muted-foreground min-w-24">{k}</dt>
              <dd className="text-foreground break-all">
                {v === null || v === undefined
                  ? <span className="italic text-muted-foreground">null</span>
                  : typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function AuditLogPage() {
  const list = useServerFn(listAuditLog);
  const [filter, setFilter] = useState<FilterKey>("all");
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit-log", filter],
    queryFn: () => list({ data: { filter } }),
  });
  const items = (data ?? []) as AuditEntry[];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/agent/approvals" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-primary" />
            Audit Log
          </h1>
          <p className="text-sm text-muted-foreground">
            Every approve/reject decision with before/after summary, timestamp, and acting admin.
          </p>
        </div>
      </div>

      <div className="flex gap-1 rounded-md border p-1 text-xs w-fit">
        {(["all", "action", "signup", "approve", "reject"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded ${filter === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </div>
      ) : items.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
          No audit entries yet.
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {items.map((entry) => {
            const d = (entry.details ?? {}) as Record<string, unknown>;
            const isApprove = entry.event_type.endsWith(".approve");
            const isSignup = entry.event_type.includes(".signup.");
            const title = (d.title as string) ?? (d.subject_name as string) ?? (d.subject_email as string) ?? (d.target_id as string) ?? "—";
            return (
              <Card key={entry.id}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isApprove
                          ? <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"><Check className="h-3 w-3 mr-1" />Approved</Badge>
                          : <Badge variant="destructive"><X className="h-3 w-3 mr-1" />Rejected</Badge>}
                        <Badge variant="outline" className="text-[10px]">{isSignup ? "Login request" : "Agent action"}</Badge>
                        {d.kind ? <Badge variant="outline" className="text-[10px]">{String(d.kind)}</Badge> : null}
                      </div>
                      <div className="text-sm font-medium mt-1 truncate">{title}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(entry.created_at).toLocaleString()} · by{" "}
                        <span className="text-foreground">
                          {entry.actor_name || entry.actor_email || entry.actor_id?.slice(0, 8) || "unknown"}
                        </span>
                        {d.reason ? <> · reason: {String(d.reason)}</> : null}
                        {d.exec_error ? <> · error: {String(d.exec_error)}</> : null}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-md border bg-muted/20 p-2 space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
                      Before <ArrowRight className="h-3 w-3" /> After
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <DiffPanel label="Before" data={d.before} tone="before" />
                      <DiffPanel label="After" data={d.after} tone="after" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/audit-log")({
  head: () => ({ meta: [{ title: "Audit Log — DelayLens" }] }),
  component: AuditLogPage,
});
