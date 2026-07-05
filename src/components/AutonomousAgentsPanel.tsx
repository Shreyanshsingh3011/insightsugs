import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Bot, Zap, FileSearch, Loader2, Activity, ShieldCheck, LineChart } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { runStandupAgent } from "@/lib/standup-agent.functions";
import { investigateDelay } from "@/lib/delay-root-cause.functions";
import { useState } from "react";

export default function AutonomousAgentsPanel() {
  const [lastRun, setLastRun] = useState<Record<string, string>>({});

  const standupFn = useServerFn(runStandupAgent);
  const standup = useMutation({
    mutationFn: () => standupFn({} as any),
    onSuccess: (r: any) => {
      toast.success(`Standup: ${r.projects_with_delays}/${r.projects_scanned} projects flagged · ${r.dms_sent} DMs · ${r.emails_queued} emails`);
      setLastRun((s) => ({ ...s, standup: new Date().toLocaleTimeString() }));
    },
    onError: (e: any) => toast.error(e?.message ?? "Standup failed"),
  });

  const investigateFn = useServerFn(investigateDelay);
  const rootCause = useMutation({
    mutationFn: () => investigateFn({ data: {} } as any),
    onError: (e: any) => toast.error(e?.message ?? "Provide an alert or draft id from the Inbox to investigate"),
  });

  return (
    <Card className="mb-4 border-primary/40 bg-gradient-to-br from-primary/[0.05] to-transparent">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="h-4 w-4 text-primary" />
          Autonomous Agents
          <Badge variant="secondary" className="ml-1 text-[10px]">3 active</Badge>
          <div className="ml-auto flex items-center gap-1 text-xs">
            <Link to="/agent/approvals" className="rounded-md border px-2 py-1 hover:bg-muted flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" /> Approvals
            </Link>
            <Link to="/agent/activity" className="rounded-md border px-2 py-1 hover:bg-muted flex items-center gap-1">
              <Activity className="h-3 w-3" /> Activity
            </Link>
            <Link to="/agent/runs" className="rounded-md border px-2 py-1 hover:bg-muted flex items-center gap-1">
              <LineChart className="h-3 w-3" /> Runs
            </Link>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-background/50 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <Zap className="h-3.5 w-3.5 text-amber-500" /> Daily Standup
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Scans every project sheet, drafts per-project standup, notifies admins,
            emails via queue, DMs assignees. Cron: 9:00 AM IST.
          </p>
          <Button size="sm" className="w-full" onClick={() => standup.mutate()} disabled={standup.isPending}>
            {standup.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            Run now
          </Button>
          {lastRun.standup ? <p className="mt-1 text-[10px] text-muted-foreground">Last: {lastRun.standup}</p> : null}
        </div>

        <div className="rounded-md border bg-background/50 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <Bot className="h-3.5 w-3.5 text-rose-500" /> Delay Root-Cause
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Auto-investigates open alerts w/o a root cause — pulls sibling rows +
            document excerpts, posts diagnosis to the alert thread.
          </p>
          <p className="text-[10px] text-muted-foreground">
            Triggers per alert from the Alerts screen; hourly hook also available at
            <code className="ml-1">/api/public/hooks/delay-root-cause</code>.
          </p>
        </div>

        <div className="rounded-md border bg-background/50 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
            <FileSearch className="h-3.5 w-3.5 text-emerald-500" /> Doc → Action Extractor
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            On any indexed document, extracts obligations, deadlines, penalties
            with page citations. Creates alerts + tracked activities.
          </p>
          <p className="text-[10px] text-muted-foreground">
            Open a document from Documents to run this agent.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
