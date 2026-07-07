import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles, CheckCircle2, XCircle, Bell, Send, MessageSquare, ListChecks, ArrowRight } from "lucide-react";
import { approvePlan, rejectPlan } from "@/lib/planner.functions";
import { useSession } from "@/hooks/useSession";

// Mirror the schema from the server route so useObject can validate stream.
const StepSchema = z.object({
  title: z.string(),
  tool: z.enum(["create_alert", "nudge_assignee", "notify"]),
  rationale: z.string(),
  payload: z.object({
    activity: z.string().nullable().optional(),
    person: z.string().nullable().optional(),
    severity: z.enum(["info", "warning", "critical"]).nullable().optional(),
    message: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
  }),
});
const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(StepSchema),
});

const TOOL_META: Record<string, { icon: React.ReactNode; label: string; color: string }> = {
  create_alert: { icon: <Bell className="h-3.5 w-3.5" />, label: "Create alert", color: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200" },
  nudge_assignee: { icon: <Send className="h-3.5 w-3.5" />, label: "Nudge assignee", color: "bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-200" },
  notify: { icon: <MessageSquare className="h-3.5 w-3.5" />, label: "Notify", color: "bg-violet-100 text-violet-900 dark:bg-violet-900/40 dark:text-violet-200" },
};

function PlannerPage() {
  const { session } = useSession();
  const [goal, setGoal] = useState("");
  const runIdRef = useRef<string | null>(null);
  const [approvedQueued, setApprovedQueued] = useState<number | null>(null);

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/agent/plan",
    schema: PlanSchema,
    onFinish: () => {},
  });

  const approveFn = useServerFn(approvePlan);
  const rejectFn = useServerFn(rejectPlan);

  const approveMut = useMutation({
    mutationFn: () => {
      const steps = (object?.steps ?? []).filter(
        (s): s is z.infer<typeof StepSchema> =>
          !!s && !!s.title && !!s.tool && !!s.rationale && !!s.payload,
      );
      if (steps.length === 0) throw new Error("Plan has no valid steps");
      return approveFn({
        data: { goal, runId: runIdRef.current, steps },
      });
    },
    onSuccess: (res) => {
      setApprovedQueued(res.queued);
      toast.success(`Approved plan — ${res.queued} action${res.queued === 1 ? "" : "s"} queued`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Approval failed"),
  });

  const rejectMut = useMutation({
    mutationFn: () => rejectFn({ data: { runId: runIdRef.current } }),
    onSuccess: () => {
      toast.message("Plan rejected");
      setApprovedQueued(null);
      runIdRef.current = null;
    },
  });

  const handleGenerate = () => {
    const g = goal.trim();
    if (!g) {
      toast.error("Enter a goal first");
      return;
    }
    setApprovedQueued(null);
    runIdRef.current = null;
    submit({ goal: g, actorId: session?.user?.id ?? null });
  };

  const steps = object?.steps ?? [];
  const canApprove = !isLoading && steps.length > 0 && approvedQueued === null;

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            Multi-step Planner
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Describe a high-level goal. The planner decomposes it into 3–8 tool calls, streams the
            plan into the UI, and queues them for approval in one batch.
          </p>
        </div>
        <Link to="/agent/approvals" className="text-sm text-primary hover:underline whitespace-nowrap">
          Approvals inbox <ArrowRight className="inline h-3 w-3" />
        </Link>
      </div>

      <Card className="p-4 space-y-3">
        <label className="text-sm font-medium">Goal</label>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Close out phase-2 delays before end of week — flag anything overdue by 3+ days and nudge the assignees."
          className="min-h-24"
          disabled={isLoading}
        />
        <div className="flex items-center gap-2">
          <Button onClick={handleGenerate} disabled={isLoading || !goal.trim()}>
            {isLoading ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Planning…</>
            ) : (
              <><Sparkles className="mr-2 h-4 w-4" />Generate plan</>
            )}
          </Button>
          {isLoading && (
            <Button variant="outline" onClick={stop}>Stop</Button>
          )}
          <div className="text-xs text-muted-foreground ml-auto">
            stopWhen: <code className="text-foreground">stepCountIs(50)</code>
          </div>
        </div>
        {error && (
          <div className="text-sm text-destructive">{error.message}</div>
        )}
      </Card>

      {(isLoading || object) && (
        <Card className="p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2">
              <ListChecks className="h-4 w-4" /> Plan
              {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              {steps.length > 0 && <Badge variant="secondary">{steps.length} step{steps.length === 1 ? "" : "s"}</Badge>}
            </h2>
            {approvedQueued !== null && (
              <Badge className="bg-emerald-600 text-white">
                {approvedQueued} queued
              </Badge>
            )}
          </div>

          {object?.summary && (
            <p className="text-sm text-muted-foreground">{object.summary}</p>
          )}

          <ol className="space-y-2">
            {steps.map((step, i) => {
              if (!step) return null;
              const meta = step.tool ? TOOL_META[step.tool] : null;
              return (
                <li
                  key={i}
                  className="rounded-md border bg-card p-3 space-y-1.5"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{step.title ?? "…"}</span>
                        {meta && (
                          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.color}`}>
                            {meta.icon}
                            {meta.label}
                          </span>
                        )}
                      </div>
                      {step.rationale && (
                        <p className="text-xs text-muted-foreground mt-0.5">{step.rationale}</p>
                      )}
                      {step.payload && (
                        <div className="text-[11px] text-muted-foreground/80 mt-1 flex flex-wrap gap-x-3">
                          {step.payload.activity && <span>Activity: <span className="text-foreground">{step.payload.activity}</span></span>}
                          {step.payload.person && <span>Person: <span className="text-foreground">{step.payload.person}</span></span>}
                          {step.payload.severity && <span>Severity: <span className="text-foreground">{step.payload.severity}</span></span>}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {approvedQueued === null && (
            <div className="flex items-center gap-2 pt-2 border-t">
              <Button
                onClick={() => approveMut.mutate()}
                disabled={!canApprove || approveMut.isPending}
              >
                {approveMut.isPending ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Queuing…</>
                ) : (
                  <><CheckCircle2 className="mr-2 h-4 w-4" />Approve whole plan</>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => rejectMut.mutate()}
                disabled={isLoading || rejectMut.isPending}
              >
                <XCircle className="mr-2 h-4 w-4" />Reject
              </Button>
              <div className="text-xs text-muted-foreground ml-auto">
                Approving queues one <code>pending_actions</code> row per step.
              </div>
            </div>
          )}

          {approvedQueued !== null && (
            <div className="pt-2 border-t flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                {approvedQueued} action{approvedQueued === 1 ? "" : "s"} queued. Each row remains
                individually reviewable.
              </div>
              <Link to="/agent/approvals">
                <Button size="sm">Open approvals inbox</Button>
              </Link>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/planner")({
  head: () => ({ meta: [{ title: "Multi-step Planner — DelayLens" }] }),
  component: PlannerPage,
});
