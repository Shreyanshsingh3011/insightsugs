import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useRoles } from "@/hooks/useSession";
import {
  listSmartAlertRules,
  createSmartAlertRule,
  toggleSmartAlertRule,
  deleteSmartAlertRule,
} from "@/lib/smart-alerts.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/smart-alerts")({
  ssr: false,
  component: Gate,
});

function Gate() {
  const { data: roles, isLoading } = useRoles();
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");
  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!isAdmin) throw redirect({ to: "/insights" });
  return <SmartAlertsPage />;
}

function SmartAlertsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listSmartAlertRules);
  const createFn = useServerFn(createSmartAlertRule);
  const toggleFn = useServerFn(toggleSmartAlertRule);
  const deleteFn = useServerFn(deleteSmartAlertRule);

  const { data: rules } = useQuery({ queryKey: ["smart-alert-rules"], queryFn: () => listFn() });
  const [phrase, setPhrase] = useState("");
  const [target, setTarget] = useState<"documents" | "sheet_rows" | "both">("both");

  const createMut = useMutation({
    mutationFn: () => createFn({ data: { phrase, target } }),
    onSuccess: () => {
      setPhrase("");
      toast.success("Rule added");
      qc.invalidateQueries({ queryKey: ["smart-alert-rules"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const toggleMut = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) => toggleFn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["smart-alert-rules"] }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Rule deleted");
      qc.invalidateQueries({ queryKey: ["smart-alert-rules"] });
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Smart alerts · keyword watch</h1>
        <p className="text-sm text-muted-foreground">
          When new documents or sheet rows contain these phrases, an alert is raised automatically (hourly scan).
          Overdue activities, at-risk activities, silent projects, and sheet anomalies are detected without configuration.
        </p>
      </div>

      <Card className="mb-4 p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Phrase</label>
            <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder='e.g. "penalty", "force majeure"' />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Watch in</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as any)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="both">Both</option>
              <option value="documents">Documents</option>
              <option value="sheet_rows">Sheet rows</option>
            </select>
          </div>
          <Button
            disabled={phrase.trim().length < 2 || createMut.isPending}
            onClick={() => createMut.mutate()}
          >
            Add rule
          </Button>
        </div>
      </Card>

      <Card className="divide-y divide-border">
        {(rules ?? []).length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">No keyword rules yet.</div>
        )}
        {(rules ?? []).map((r) => (
          <div key={r.id} className="flex items-center gap-3 p-3">
            <div className="flex-1">
              <div className="text-sm font-medium">{r.phrase}</div>
              <div className="text-xs text-muted-foreground">Watches: {r.target === "both" ? "documents & sheet rows" : r.target === "documents" ? "documents" : "sheet rows"}</div>
            </div>
            <Switch
              checked={r.is_active}
              onCheckedChange={(v) => toggleMut.mutate({ id: r.id, is_active: v })}
            />
            <Button variant="ghost" size="icon" onClick={() => deleteMut.mutate(r.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
