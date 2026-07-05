import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listEvalCases,
  listRecentEvalRuns,
  createEvalCase,
  deleteEvalCase,
  runEvalSuite,
  type EvalCase,
  type EvalRun,
} from "@/lib/evals.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Play, Trash2, Plus, FlaskConical, Check, X } from "lucide-react";

function EvalsPage() {
  const listCases = useServerFn(listEvalCases);
  const listRuns = useServerFn(listRecentEvalRuns);
  const create = useServerFn(createEvalCase);
  const del = useServerFn(deleteEvalCase);
  const runAll = useServerFn(runEvalSuite);
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [expectedTool, setExpectedTool] = useState("");

  const casesQ = useQuery({ queryKey: ["eval-cases"], queryFn: () => listCases() });
  const runsQ = useQuery({ queryKey: ["eval-runs"], queryFn: () => listRuns() });

  const addMut = useMutation({
    mutationFn: () =>
      create({ data: { name, prompt, expected_tool: expectedTool || undefined } }),
    onSuccess: () => {
      toast.success("Case added");
      setName(""); setPrompt(""); setExpectedTool("");
      qc.invalidateQueries({ queryKey: ["eval-cases"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["eval-cases"] }),
  });

  const runMut = useMutation({
    mutationFn: () => runAll(),
    onSuccess: (r) => {
      toast.success(`Ran ${r.total} cases — ${r.passed} passed`);
      qc.invalidateQueries({ queryKey: ["eval-runs"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const cases = (casesQ.data ?? []) as EvalCase[];
  const runs = (runsQ.data ?? []) as EvalRun[];

  // Latest run per case
  const latestByCase = new Map<string, EvalRun>();
  for (const r of runs) if (!latestByCase.has(r.case_id)) latestByCase.set(r.case_id, r);

  const passRate =
    cases.length > 0
      ? Math.round(
          (cases.filter((c) => latestByCase.get(c.id)?.passed).length / cases.length) * 100,
        )
      : 0;

  const totalTokens = runs.reduce((a, r) => a + (r.tokens_in ?? 0) + (r.tokens_out ?? 0), 0);
  const avgLatency =
    runs.length > 0
      ? Math.round(runs.reduce((a, r) => a + (r.latency_ms ?? 0), 0) / runs.length)
      : 0;

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/agent"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Back</Button></Link>
        <FlaskConical className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Agent Evals</h1>
        <div className="ml-auto">
          <Button size="sm" onClick={() => runMut.mutate()} disabled={runMut.isPending}>
            <Play className="h-4 w-4 mr-1" />
            {runMut.isPending ? "Running…" : "Run all"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Cases</div><div className="text-2xl font-semibold">{cases.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Pass rate</div><div className="text-2xl font-semibold">{passRate}%</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Avg latency</div><div className="text-2xl font-semibold">{avgLatency} ms</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Total tokens</div><div className="text-2xl font-semibold">{totalTokens.toLocaleString()}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Add case</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Expected tool (optional)" value={expectedTool} onChange={(e) => setExpectedTool(e.target.value)} />
            <Input placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="md:col-span-1" />
          </div>
          <Button size="sm" onClick={() => addMut.mutate()} disabled={!name || !prompt || addMut.isPending}>
            <Plus className="h-4 w-4 mr-1" />Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Golden set</CardTitle></CardHeader>
        <CardContent>
          {casesQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : (
            <ul className="divide-y">
              {cases.map((c) => {
                const last = latestByCase.get(c.id);
                return (
                  <li key={c.id} className="py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium">{c.name}</span>
                        {c.expected_tool && <Badge variant="outline">→ {c.expected_tool}</Badge>}
                        {last && (
                          last.passed
                            ? <Badge className="bg-green-600"><Check className="h-3 w-3 mr-1" />pass</Badge>
                            : <Badge variant="destructive"><X className="h-3 w-3 mr-1" />fail</Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground">{c.prompt}</div>
                      {last?.tool_called && (
                        <div className="text-xs mt-1">called: <code>{last.tool_called}</code> · {last.latency_ms} ms</div>
                      )}
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => delMut.mutate(c.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/evals")({
  component: EvalsPage,
});
