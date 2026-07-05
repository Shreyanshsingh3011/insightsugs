import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listAgentMemory,
  upsertAgentMemory,
  deleteAgentMemory,
  type AgentMemoryRow,
} from "@/lib/agent-memory.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Trash2, Plus, Brain } from "lucide-react";

function MemoryPage() {
  const list = useServerFn(listAgentMemory);
  const upsert = useServerFn(upsertAgentMemory);
  const del = useServerFn(deleteAgentMemory);
  const qc = useQueryClient();
  const [kind, setKind] = useState("preference");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["agent-memory"],
    queryFn: () => list(),
  });

  const addMut = useMutation({
    mutationFn: () => upsert({ data: { kind, key, value, importance: 2 } }),
    onSuccess: () => {
      toast.success("Saved");
      setKey("");
      setValue("");
      qc.invalidateQueries({ queryKey: ["agent-memory"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["agent-memory"] });
    },
  });

  const items = (data ?? []) as AgentMemoryRow[];

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/agent"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Back</Button></Link>
        <Brain className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Agent Memory</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Durable facts the copilot remembers about you across sessions. The agent can also add facts here via the <code>rememberFact</code> tool.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">Add fact</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <select
              className="border rounded-md px-3 py-2 text-sm bg-background"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="preference">preference</option>
              <option value="person">person</option>
              <option value="project">project</option>
              <option value="note">note</option>
            </select>
            <Input placeholder="key (e.g. default_project)" value={key} onChange={(e) => setKey(e.target.value)} />
            <Input className="md:col-span-2" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <Button size="sm" onClick={() => addMut.mutate()} disabled={!key || !value || addMut.isPending}>
            <Plus className="h-4 w-4 mr-1" />Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Saved facts ({items.length})</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted-foreground">No memory yet. Say "remember that…" to the copilot, or add above.</div>
          ) : (
            <ul className="divide-y">
              {items.map((m) => (
                <li key={m.id} className="py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline">{m.kind}</Badge>
                      <span className="text-xs text-muted-foreground">{m.key}</span>
                      {m.importance >= 4 && <Badge variant="secondary">important</Badge>}
                    </div>
                    <div className="text-sm">{m.value}</div>
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => delMut.mutate(m.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/memory")({
  component: MemoryPage,
});
