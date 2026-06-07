import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, MessageSquare, Plus } from "lucide-react";
import {
  listConcerns,
  getConcern,
  replyToConcern,
  acknowledgeConcern,
  resolveConcern,
} from "@/lib/concerns.functions";
import { RaiseConcernDialog } from "@/components/RaiseConcernDialog";

export const Route = createFileRoute("/_authenticated/concerns")({
  head: () => ({ meta: [{ title: "Concerns — DelayLens" }] }),
  component: ConcernsPage,
});

type Concern = {
  id: string;
  raised_by: string;
  raised_by_dept: string | null;
  target_dept: string;
  activity: string | null;
  title: string;
  body: string;
  severity: "Low" | "Medium" | "High" | "Critical";
  status: "open" | "acknowledged" | "resolved";
  created_at: string;
};

function sevColor(sev: string) {
  switch (sev) {
    case "Critical": return "bg-destructive/15 text-destructive";
    case "High": return "bg-orange-500/15 text-orange-600 dark:text-orange-300";
    case "Medium": return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    default: return "bg-muted text-muted-foreground";
  }
}
function statusColor(s: string) {
  switch (s) {
    case "open": return "bg-blue-500/15 text-blue-600 dark:text-blue-300";
    case "acknowledged": return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "resolved": return "bg-green-500/15 text-green-700 dark:text-green-300";
    default: return "bg-muted text-muted-foreground";
  }
}

function ConcernsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listConcerns);
  const [openId, setOpenId] = useState<string | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [tab, setTab] = useState<"mine" | "team">("team");

  const { data, isLoading } = useQuery({
    queryKey: ["concerns"],
    queryFn: () => listFn(),
  });
  const concerns: Concern[] = data?.concerns ?? [];
  const me = data?.me;

  const filtered = useMemo(() => {
    if (tab === "mine") return concerns.filter((c) => c.raised_by === me);
    return concerns.filter((c) => c.raised_by !== me);
  }, [concerns, tab, me]);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Concerns
          </h1>
          <p className="text-sm text-muted-foreground">
            Cross-department issues — raise, acknowledge, discuss, resolve.
          </p>
        </div>
        <Button onClick={() => setRaiseOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Raise concern
        </Button>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="team">For my department</TabsTrigger>
          <TabsTrigger value="mine">Raised by me</TabsTrigger>
        </TabsList>

        <TabsContent value={tab}>
          <Card className="mt-3 border-border bg-card">
            {isLoading ? (
              <p className="p-5 text-sm text-muted-foreground">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="p-5 text-sm text-muted-foreground">No concerns in this view.</p>
            ) : (
              <ul className="divide-y divide-border">
                {filtered.map((c) => (
                  <li
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="cursor-pointer p-4 transition-colors hover:bg-accent/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${sevColor(c.severity)}`}>{c.severity}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${statusColor(c.status)}`}>{c.status}</span>
                          <span className="text-xs text-muted-foreground">→ {c.target_dept}</span>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{c.title}</p>
                        {c.activity && <p className="text-xs text-muted-foreground truncate">Activity: {c.activity}</p>}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <ConcernDetailDialog
        id={openId}
        onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ["concerns"] }); }}
      />
      <RaiseConcernDialog open={raiseOpen} onOpenChange={(o) => { setRaiseOpen(o); if (!o) qc.invalidateQueries({ queryKey: ["concerns"] }); }} />
    </main>
  );
}

function ConcernDetailDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getConcern);
  const replyFn = useServerFn(replyToConcern);
  const ackFn = useServerFn(acknowledgeConcern);
  const resolveFn = useServerFn(resolveConcern);
  const [reply, setReply] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["concern", id],
    queryFn: () => getFn({ data: { id: id! } }),
    enabled: !!id,
  });

  const replyMut = useMutation({
    mutationFn: () => replyFn({ data: { id: id!, body: reply } }),
    onSuccess: () => {
      setReply("");
      qc.invalidateQueries({ queryKey: ["concern", id] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Reply failed"),
  });
  const ackMut = useMutation({
    mutationFn: () => ackFn({ data: { id: id! } }),
    onSuccess: () => { toast.success("Acknowledged"); qc.invalidateQueries({ queryKey: ["concern", id] }); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const resolveMut = useMutation({
    mutationFn: () => resolveFn({ data: { id: id! } }),
    onSuccess: () => { toast.success("Resolved"); qc.invalidateQueries({ queryKey: ["concern", id] }); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  if (!id) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="max-h-[90vh] w-full max-w-2xl overflow-auto border-border bg-card p-5" onClick={(e) => e.stopPropagation()}>
        {isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <header className="mb-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${sevColor(data.concern.severity)}`}>{data.concern.severity}</span>
                <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${statusColor(data.concern.status)}`}>{data.concern.status}</span>
                <span className="text-xs text-muted-foreground">→ {data.concern.target_dept}</span>
              </div>
              <h2 className="mt-2 text-base font-semibold">{data.concern.title}</h2>
              {data.concern.activity && <p className="text-xs text-muted-foreground">Activity: {data.concern.activity}</p>}
              {data.concern.body && <p className="mt-2 whitespace-pre-wrap text-sm">{data.concern.body}</p>}
            </header>

            <div className="space-y-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5" /> Thread
              </h3>
              {data.messages.length === 0 && <p className="text-xs text-muted-foreground">No replies yet.</p>}
              {data.messages.map((m: any) => (
                <div key={m.id} className="rounded-md border border-border bg-background/40 p-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{m.author?.full_name || m.author?.email || "User"}</span>
                    <span>{new Date(m.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{m.body}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-2">
              <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" rows={3} maxLength={4000} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => ackMut.mutate()} disabled={ackMut.isPending || data.concern.status !== "open"}>
                    Acknowledge
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resolveMut.mutate()} disabled={resolveMut.isPending || data.concern.status === "resolved"}>
                    <CheckCircle2 className="mr-1 h-4 w-4" /> Resolve
                  </Button>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
                  <Button size="sm" onClick={() => replyMut.mutate()} disabled={!reply.trim() || replyMut.isPending}>
                    {replyMut.isPending ? "Sending…" : "Reply"}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
