import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listPendingActions,
  decidePendingAction,
  type PendingAction,
} from "@/lib/pending-actions.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Check, X, Loader2, ShieldCheck, ArrowLeft } from "lucide-react";

function ApprovalsPage() {
  const list = useServerFn(listPendingActions);
  const decide = useServerFn(decidePendingAction);
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected" | "all">("pending");

  const { data, isLoading, error } = useQuery({
    queryKey: ["pending-actions", tab],
    queryFn: () => list({ data: { status: tab } }),
  });

  const decideMut = useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject" }) =>
      decide({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(v.decision === "approve" ? "Approved & executed" : "Rejected");
      qc.invalidateQueries({ queryKey: ["pending-actions"] });
      qc.invalidateQueries({ queryKey: ["pending-actions-count"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const items = (data ?? []) as PendingAction[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/agent" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Approvals
            </h1>
            <p className="text-sm text-muted-foreground">
              Actions proposed by agents. Nothing runs until you approve.
            </p>
          </div>
        </div>
        <div className="flex gap-1 rounded-md border p-1 text-xs">
          {(["pending", "approved", "rejected", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              className={`px-3 py-1 rounded ${tab === s ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {s}
            </button>
          ))}
        </div>
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
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No {tab === "all" ? "" : tab} actions. Ask the copilot to propose one
            (e.g. "flag activity X as critical").
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <Card key={a.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
                <div className="min-w-0">
                  <CardTitle className="text-base flex items-center gap-2">
                    {a.title ?? a.summary}
                    <Badge variant="outline" className="text-[10px]">{a.kind}</Badge>
                    <Badge
                      variant={a.status === "pending" ? "secondary" : a.status === "executed" || a.status === "approved" ? "default" : "destructive"}
                      className="text-[10px]"
                    >
                      {a.status}
                    </Badge>
                  </CardTitle>
                  <div className="text-xs text-muted-foreground mt-1">{a.summary}</div>
                </div>
                {a.status === "pending" ? (
                  <div className="flex gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decideMut.mutate({ id: a.id, decision: "reject" })}
                      disabled={decideMut.isPending}
                    >
                      <X className="h-3.5 w-3.5 mr-1" /> Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => decideMut.mutate({ id: a.id, decision: "approve" })}
                      disabled={decideMut.isPending}
                    >
                      <Check className="h-3.5 w-3.5 mr-1" /> Approve
                    </Button>
                  </div>
                ) : null}
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                {a.rationale ? (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Rationale: </span>
                    {a.rationale}
                  </div>
                ) : null}
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">Payload</summary>
                  <pre className="mt-1 overflow-auto rounded bg-muted/50 p-2 text-[11px]">
                    {JSON.stringify(a.payload, null, 2)}
                  </pre>
                </details>
                <div className="text-[11px] text-muted-foreground">
                  Proposed {new Date(a.created_at).toLocaleString()}
                  {a.decided_at ? ` · decided ${new Date(a.decided_at).toLocaleString()}` : ""}
                  {a.execution_error ? ` · error: ${a.execution_error}` : ""}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/approvals")({
  head: () => ({ meta: [{ title: "Approvals — DelayLens" }] }),
  component: ApprovalsPage,
});
