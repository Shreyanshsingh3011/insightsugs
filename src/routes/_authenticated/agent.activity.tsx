import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listAgentRuns, getAgentStats, type AgentRunRow } from "@/lib/agent-runs.functions";
import { listPendingActions, type PendingAction } from "@/lib/pending-actions.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, ShieldCheck, ArrowLeft, Bot, Zap, CheckCircle2, AlertTriangle, ArrowRight } from "lucide-react";

function AgentIcon({ agent }: { agent: string }) {
  if (agent === "chatbot") return <Bot className="h-4 w-4 text-primary" />;
  if (agent === "approval") return <ShieldCheck className="h-4 w-4 text-emerald-500" />;
  if (agent === "watcher") return <Zap className="h-4 w-4 text-amber-500" />;
  return <Activity className="h-4 w-4 text-muted-foreground" />;
}

function ActivityPage() {
  const runs = useServerFn(listAgentRuns);
  const acts = useServerFn(listPendingActions);
  const stats = useServerFn(getAgentStats);

  const runsQ = useQuery({
    queryKey: ["activity-runs"],
    queryFn: () => runs({ data: { scope: "all", limit: 30 } }),
  });
  const actsQ = useQuery({
    queryKey: ["activity-actions"],
    queryFn: () => acts({ data: { status: "all", limit: 20 } }),
  });
  const statsQ = useQuery({ queryKey: ["agent-stats"], queryFn: () => stats({}) });

  const runList = (runsQ.data ?? []) as AgentRunRow[];
  const actList = (actsQ.data ?? []) as PendingAction[];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/agent" className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Agent Activity
          </h1>
          <p className="text-sm text-muted-foreground">Everything agents did in the last 7 days.</p>
        </div>
      </div>

      {statsQ.data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Runs" value={statsQ.data.total_runs} />
          <StatCard label="Succeeded" value={statsQ.data.succeeded} tone="ok" />
          <StatCard label="Failed" value={statsQ.data.failed} tone={statsQ.data.failed > 0 ? "bad" : "muted"} />
          <StatCard label="Avg latency" value={statsQ.data.avg_latency_ms ? `${statsQ.data.avg_latency_ms} ms` : "—"} />
          <StatCard label="Tokens (7d)" value={statsQ.data.total_tokens.toLocaleString()} />
          <StatCard label="👍" value={statsQ.data.thumbs_up} tone="ok" />
          <StatCard label="👎" value={statsQ.data.thumbs_down} tone={statsQ.data.thumbs_down > 0 ? "bad" : "muted"} />
          <StatCard label="Pending approvals" value={statsQ.data.pending_actions} />
        </div>
      ) : null}

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Recent runs</CardTitle>
            <Link to="/agent/runs" className="text-xs text-primary hover:underline flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[520px] overflow-auto">
            {runList.length === 0 ? (
              <div className="text-sm text-muted-foreground">No runs yet.</div>
            ) : (
              runList.map((r) => (
                <div key={r.id} className="flex items-start gap-2 border-b last:border-0 pb-2">
                  <AgentIcon agent={r.agent} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {r.agent} <Badge variant="outline" className="text-[10px]">{r.trigger}</Badge>
                      {r.status === "succeeded" ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                      ) : r.status === "failed" ? (
                        <AlertTriangle className="h-3 w-3 text-destructive" />
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {r.error ?? summarize(r.input) ?? "—"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                      {r.latency_ms ? ` · ${r.latency_ms}ms` : ""}
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-base">Proposed actions</CardTitle>
            <Link to="/agent/approvals" className="text-xs text-primary hover:underline flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[520px] overflow-auto">
            {actList.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No proposed actions yet. Ask the copilot to "flag" or "nudge" something.
              </div>
            ) : (
              actList.map((a) => (
                <div key={a.id} className="flex items-start gap-2 border-b last:border-0 pb-2">
                  <ShieldCheck className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.title ?? a.summary}</div>
                    <div className="text-xs text-muted-foreground truncate">{a.summary}</div>
                    <div className="text-[10px] text-muted-foreground">
                      <Badge variant="outline" className="text-[10px] mr-1">{a.kind}</Badge>
                      <Badge
                        variant={a.status === "pending" ? "secondary" : "default"}
                        className="text-[10px] mr-1"
                      >
                        {a.status}
                      </Badge>
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "bad" | "muted" }) {
  const color =
    tone === "ok" ? "text-emerald-600"
    : tone === "bad" ? "text-destructive"
    : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
        <div className={`text-lg font-semibold ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function summarize(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.question === "string") return o.question;
  try { return JSON.stringify(o).slice(0, 120); } catch { return null; }
}

export const Route = createFileRoute("/_authenticated/agent/activity")({
  head: () => ({ meta: [{ title: "Agent Activity — DelayLens" }] }),
  component: ActivityPage,
});
