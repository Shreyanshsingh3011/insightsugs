import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  listCustomAgents,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  rotateWebhookSecret,
  type CustomAgent,
} from "@/lib/custom-agents.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2, Copy, RefreshCw, Bot, Webhook } from "lucide-react";

const AVAILABLE_TOOLS = [
  "getDashboardSummary",
  "getPersonWorkload",
  "topDelays",
  "filterActivities",
  "getOpenAlerts",
  "proposeCreateAlert",
  "proposeNudgeAssignee",
];

function CustomAgentsPage() {
  const list = useServerFn(listCustomAgents);
  const create = useServerFn(createCustomAgent);
  const update = useServerFn(updateCustomAgent);
  const del = useServerFn(deleteCustomAgent);
  const rotate = useServerFn(rotateWebhookSecret);
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const { data, isLoading } = useQuery({ queryKey: ["custom-agents"], queryFn: () => list() });
  const items = (data ?? []) as CustomAgent[];

  const createMut = useMutation({
    mutationFn: () =>
      create({ data: { name, description, system_prompt: prompt, tool_allowlist: selectedTools } }),
    onSuccess: () => {
      toast.success("Agent created");
      setName(""); setDescription(""); setPrompt(""); setSelectedTools([]);
      qc.invalidateQueries({ queryKey: ["custom-agents"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const updateMut = useMutation({
    mutationFn: (v: Parameters<typeof update>[0]["data"]) => update({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-agents"] }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["custom-agents"] }),
  });

  const rotateMut = useMutation({
    mutationFn: (id: string) => rotate({ data: { id } }),
    onSuccess: () => {
      toast.success("Secret rotated");
      qc.invalidateQueries({ queryKey: ["custom-agents"] });
    },
  });

  const toggleTool = (name: string) =>
    setSelectedTools((s) => (s.includes(name) ? s.filter((x) => x !== name) : [...s, name]));

  return (
    <div className="container mx-auto p-4 md:p-6 max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/agent"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Back</Button></Link>
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Custom Agents</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Define your own agents with a system prompt and a tool allow-list. Enable a webhook to trigger them from any external service (Zapier, n8n, cron, curl).
      </p>

      <Card>
        <CardHeader><CardTitle className="text-base">New agent</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Input placeholder="Name (e.g. Weekly Digest Bot)" value={name} onChange={(e) => setName(e.target.value)} />
            <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Textarea
            placeholder="System prompt — describe what the agent does, its tone, and any rules."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
          />
          <div>
            <div className="text-xs font-medium mb-1">Tool allow-list</div>
            <div className="flex flex-wrap gap-1">
              {AVAILABLE_TOOLS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTool(t)}
                  className={`text-xs rounded-md border px-2 py-1 ${selectedTools.includes(t) ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <Button size="sm" onClick={() => createMut.mutate()} disabled={!name || !prompt || createMut.isPending}>
            <Plus className="h-4 w-4 mr-1" />Create agent
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-3">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground">No custom agents yet.</div>
        ) : (
          items.map((a) => {
            const webhookUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/public/hooks/agent/${a.id}`;
            return (
              <Card key={a.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    {a.name}
                    {a.active ? <Badge variant="secondary">active</Badge> : <Badge variant="outline">paused</Badge>}
                    {a.webhook_enabled && <Badge className="bg-blue-600"><Webhook className="h-3 w-3 mr-1" />webhook on</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{a.run_count} runs</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {a.description && <div className="text-muted-foreground">{a.description}</div>}
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Tools</div>
                    <div className="flex flex-wrap gap-1">
                      {a.tool_allowlist.length === 0
                        ? <span className="text-xs text-muted-foreground">(none — chat only)</span>
                        : a.tool_allowlist.map((t) => <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>)}
                    </div>
                  </div>
                  <div className="rounded-md border p-2 bg-muted/30 space-y-2">
                    <div className="flex items-center gap-2 text-xs">
                      <Webhook className="h-3 w-3" />
                      <span className="font-medium">Webhook</span>
                      <label className="ml-auto flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={a.webhook_enabled}
                          onChange={(e) => updateMut.mutate({ id: a.id, webhook_enabled: e.target.checked })}
                        />
                        <span>enabled</span>
                      </label>
                    </div>
                    <code className="block text-[11px] break-all">{webhookUrl}</code>
                    <div className="flex items-center gap-2">
                      <code className="text-[11px] px-2 py-1 rounded bg-background border flex-1 truncate">
                        secret: {a.webhook_secret.slice(0, 8)}…{a.webhook_secret.slice(-4)}
                      </code>
                      <Button size="sm" variant="outline" onClick={() => {
                        navigator.clipboard.writeText(a.webhook_secret);
                        toast.success("Secret copied");
                      }}>
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => rotateMut.mutate(a.id)}>
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      POST with header <code>x-agent-secret: &lt;secret&gt;</code> and body <code>{`{"input":"..."}`}</code>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => updateMut.mutate({ id: a.id, active: !a.active })}>
                      {a.active ? "Pause" : "Resume"}
                    </Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={() => delMut.mutate(a.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated/agent/custom")({
  component: CustomAgentsPage,
});
