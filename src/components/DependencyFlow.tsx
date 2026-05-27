import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";

export type Activity = {
  uid: string;
  id: number;
  description: string;
  stage: string;
  criticality: "Critical" | "Normal";
  status: string;
  dependsOn: number[];
};

const NODE_W = 240;
const NODE_H = 100;
const ACCENT = "oklch(0.7 0.18 25)";

function parseDelay(status: string): number {
  const m = status.match(/(\d+)\s*days?\s*delay/i);
  return m ? parseInt(m[1], 10) : 0;
}

function statusBorder(status: string, delay: number): string {
  const s = status.toLowerCase();
  if (delay > 0 || s.includes("delay") || s.includes("block")) return "border-destructive/60";
  if (s.includes("on track")) return "border-emerald-500/50";
  if (s.includes("done") || s.includes("complet")) return "border-sky-500/50";
  return "border-border";
}

type ActivityNodeData = Activity & Record<string, unknown>;

function ActivityNode({ data }: NodeProps<Node<ActivityNodeData, "activity">>) {
  const delay = parseDelay(data.status);
  const border = statusBorder(data.status, delay);
  return (
    <div
      className={`w-[240px] rounded-xl border ${border} bg-card/95 p-3 shadow-sm backdrop-blur transition-transform duration-150 hover:scale-[1.02]`}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !bg-muted-foreground" />
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-muted-foreground">#{data.uid}</span>
        {data.criticality === "Critical" && (
          <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
            Critical
          </span>
        )}
      </div>
      <div className="mt-1 line-clamp-2 text-[13px] font-medium text-foreground">
        {data.description}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {data.stage}
        </span>
        {delay > 0 && (
          <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
            +{delay}d
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !bg-muted-foreground" />
    </div>
  );
}

const nodeTypes = { activity: ActivityNode };

function layoutNodes(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

export function DependencyFlow({ activities }: { activities: Activity[] }) {
  const { nodes, edges } = useMemo(() => {
    const byId = new Map(activities.map((a) => [a.id, a]));
    const rawNodes: Node[] = activities.map((a) => ({
      id: a.uid,
      type: "activity",
      position: { x: 0, y: 0 },
      data: a as unknown as ActivityNodeData,
    }));
    const rawEdges: Edge[] = [];
    activities.forEach((a) => {
      a.dependsOn.forEach((pid) => {
        const parent = byId.get(pid);
        if (!parent) return;
        rawEdges.push({
          id: `${a.uid}->${parent.uid}`,
          source: a.uid,
          target: parent.uid,
          type: "smoothstep",
          animated: true,
          style: { stroke: ACCENT, strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: ACCENT, width: 18, height: 18 },
        });
      });
    });
    return { nodes: layoutNodes(rawNodes, rawEdges), edges: rawEdges };
  }, [activities]);

  if (!activities.length) {
    return (
      <div className="flex h-[560px] items-center justify-center rounded-xl border border-border bg-background/40 text-sm text-muted-foreground">
        No activities to graph.
      </div>
    );
  }

  return (
    <div className="h-[560px] overflow-hidden rounded-xl border border-border bg-background/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="oklch(0.3 0.02 260)" gap={24} />
        <Controls className="!border !border-border !bg-card !text-foreground [&_button]:!border-border [&_button]:!bg-card [&_button]:!text-foreground [&_button:hover]:!bg-secondary" />
      </ReactFlow>
    </div>
  );
}
