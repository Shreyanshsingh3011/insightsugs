import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listAgentRuns, type AgentRunRow } from "@/lib/agent-runs.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ChevronDown, ChevronRight, Activity } from "lucide-react";

type ToolCall = { name: string; input?: unknown; output?: unknown; ms?: number };

function Row({ r }: { r: AgentRunRow }) {
  const [open, setOpen] = useState(false);
  const calls = Array.isArray(r.tool_calls) ? (r.tool_calls as ToolCall[]) : [];
  return (
    <div className="border rounded-md">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/40"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="text-sm font-medium">{r.agent}</span>
        <Badge variant="outline" className="text-[10px]">{r.trigger}</Badge>
        <Badge
          variant={r.status === "succeeded" ? "default" : r.status === "failed" ? "destructive" : "secondary"}
          className="text-[10px]"
        >
          {r.status}
        </Badge>
        <span className="ml-auto text-xs text-muted-foreground">
          {r.latency_ms ? `${r.latency_ms}ms · ` : ""}
          {(r.tokens_in ?? 0) + (r.tokens_out ?? 0)} tok · {calls.length} tools
          {r.feedback ? (r.feedback > 0 ? " · 👍" : " · 👎") : ""}
        </span>
      </button>
      {open ? (
        <div className="border-t p-3 space-y-3 bg-muted/20 text-xs">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
            <Field label="Started" value={new Date(r.created_at).toLocaleString()} />
            <Field label="Finished" value={r.finished_at ? new Date(r.finished_at).toLocaleString() : "—"} />
            <Field label="Tokens in" value={r.tokens_in ?? "—"} />
            <Field label="Tokens out" value={r.tokens_out ?? "—"} />
          </div>
          {r.error ? (
            <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-destructive">
              Error: {r.error}
            </div>
          ) : null}
          <details open>
            <summary className="cursor-pointer text-muted-foreground">Input</summary>
            <pre className="mt-1 overflow-auto rounded bg-background p-2">{JSON.stringify(r.input, null, 2)}</pre>
          </details>
          {calls.length > 0 ? (
            <details open>
              <summary className="cursor-pointer text-muted-foreground">Tool trace ({calls.length})</summary>
              <ol className="mt-1 space-y-1">
                {calls.map((c, i) => (
                  <li key={i} className="rounded border bg-background p-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11px]">{c.name}</span>
                      <span className="text-muted-foreground">{c.ms ?? "—"}ms</span>
                    </div>
                    {c.input !== undefined ? (
                      <pre className="mt-1 overflow-auto text-[10px] text-muted-foreground">{JSON.stringify(c.input)}</pre>
                    ) : null}
                    {c.output !== undefined ? (
                      <pre className="mt-1 overflow-auto text-[10px]">{JSON.stringify(c.output).slice(0, 500)}</pre>
                    ) : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {r.feedback_note ? (
            <div className="rounded border p-2">
              <span className="text-muted-foreground">User note: </span>{r.feedback_note}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function RunsPage() {
  const runs = useServerFn(listAgentRuns);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const { data, isLoading, error } = useQuery({
    queryKey: ["agent-runs", scope],
    queryFn: () => runs({ data: { scope, limit: 100 } }),
  });
  const rows = (data ?? []) as AgentRunRow[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/agent" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              Agent Runs
            </h1>
            <p className="text-sm text-muted-foreground">
              Every call, tool trace, tokens, latency, and your feedback.
            </p>
          </div>
        </div>
        <div className="flex gap-1 rounded-md border p-1 text-xs">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`px-3 py-1 rounded ${scope === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed"}</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No runs yet. Ask the copilot a question to see it here.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => <Row key={r.id} r={r} />)}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/runs")({
  head: () => ({ meta: [{ title: "Agent Runs — DelayLens" }] }),
  component: RunsPage,
});
