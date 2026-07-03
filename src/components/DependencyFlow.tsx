import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, User as UserIcon, Circle, CheckCircle2, Clock } from "lucide-react";

export type Activity = {
  uid: string;
  id: number;
  description: string;
  stage: string;
  criticality: "Critical" | "Normal";
  status: string;
  dependsOn: number[];
  assignee?: string;
  eta?: string;
};

function statusIcon(s: string) {
  if (/complete|done/i.test(s)) return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
  if (/progress|ongoing/i.test(s)) return <Clock className="h-3.5 w-3.5 text-amber-500" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
}

// Simplistic, source-dependent dependency resolver: renders only the direct
// "A waits on B" chains found in the provided activities. No graph library,
// no zoom — just a scannable list grouped by blocked activity.
export function DependencyFlow({ activities }: { activities: Activity[] }) {
  const rows = useMemo(() => {
    const byId = new Map(activities.map((a) => [a.id, a]));
    return activities
      .filter((a) => a.dependsOn.length > 0)
      .map((a) => ({
        activity: a,
        blockers: a.dependsOn.map((pid) => byId.get(pid)).filter(Boolean) as Activity[],
      }))
      .sort((a, b) => (b.activity.criticality === "Critical" ? 1 : 0) - (a.activity.criticality === "Critical" ? 1 : 0));
  }, [activities]);

  if (!activities.length) {
    return (
      <div className="rounded-xl border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No activities to graph.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
        No dependencies declared in the current source.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map(({ activity, blockers }) => (
        <div
          key={activity.uid}
          className="rounded-xl border border-border bg-card/60 p-3 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            {statusIcon(activity.status)}
            <span className="text-sm font-semibold">{activity.description}</span>
            {activity.criticality === "Critical" && (
              <Badge variant="outline" className="border-rose-500/40 bg-rose-500/10 text-rose-600">
                Critical
              </Badge>
            )}
            {activity.assignee && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <UserIcon className="h-3 w-3" /> {activity.assignee}
              </span>
            )}
          </div>
          <div className="mt-2 space-y-1 pl-5">
            {blockers.map((b) => (
              <div key={b.uid} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <ArrowRight className="h-3 w-3" />
                <span className="text-foreground/80">waits on</span>
                <span className="font-medium text-foreground">{b.description}</span>
                {b.assignee && <span>· {b.assignee}</span>}
                {b.status && <span>· {b.status}</span>}
                {b.eta && <span>· ETA {b.eta}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
