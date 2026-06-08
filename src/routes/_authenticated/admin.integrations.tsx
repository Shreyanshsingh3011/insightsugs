import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useRoles } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Plug,
  KeyRound,
  Activity,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import {
  getEmergentConfig,
  upsertEmergentEnv,
  deleteEmergentEnv,
  setActiveEmergentEnv,
  testEmergentConnection,
} from "@/lib/integrations.functions";

export const Route = createFileRoute("/_authenticated/admin/integrations")({
  head: () => ({ meta: [{ title: "Integrations — DelayLens" }] }),
  component: IntegrationsPage,
});

type EnvOut = { id: string; name: string; base_url: string; hasKey: boolean };

function IntegrationsPage() {
  const { data: roles, isLoading: rolesLoading } = useRoles();
  const isSuper = !!roles?.includes("super_admin");
  const getFn = useServerFn(getEmergentConfig);
  const upsertFn = useServerFn(upsertEmergentEnv);
  const deleteFn = useServerFn(deleteEmergentEnv);
  const setActiveFn = useServerFn(setActiveEmergentEnv);
  const testFn = useServerFn(testEmergentConnection);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["emergent-config"],
    queryFn: () => getFn(),
    enabled: !rolesLoading && isSuper,
  });

  const [editing, setEditing] = useState<EnvOut | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; status: number; message: string }>
  >({});

  const setActiveMut = useMutation({
    mutationFn: (env_id: string) => setActiveFn({ data: { env_id } }),
    onSuccess: () => {
      toast.success("Active environment updated");
      refetch();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (env_id: string) => deleteFn({ data: { env_id } }),
    onSuccess: () => {
      toast.success("Environment removed");
      refetch();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const handleTest = async (env_id: string) => {
    setTesting(env_id);
    try {
      const r: any = await testFn({ data: { env_id } });
      setTestResults((prev) => ({ ...prev, [env_id]: r }));
    } catch (e: any) {
      setTestResults((prev) => ({
        ...prev,
        [env_id]: { ok: false, status: 0, message: e?.message ?? "Test failed" },
      }));
    } finally {
      setTesting(null);
    }
  };

  if (rolesLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (!isSuper) {
    throw redirect({ to: "/dashboard" });
  }

  const envs = data?.environments ?? [];
  const active = data?.active_env ?? null;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Plug className="h-5 w-5 text-primary" /> Integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage Emergent AI endpoints across environments (e.g. dev, staging, prod).
        </p>
      </header>

      <Card className="space-y-5 border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Emergent AI environments</h2>
            <p className="text-xs text-muted-foreground">
              The active environment is used for all AI calls (mapping, Copilot,
              dependency inference).
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Add environment
          </Button>
        </div>

        {envs.length > 0 && (
          <div className="space-y-2">
            <Label className="text-xs">Active environment</Label>
            <Select
              value={active ?? undefined}
              onValueChange={(v) => setActiveMut.mutate(v)}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {envs.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name} <span className="text-muted-foreground">({e.id})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : envs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No environments yet. Add one to enable AI features.
          </div>
        ) : (
          <div className="space-y-2">
            {envs.map((env) => {
              const isActive = env.id === active;
              const test = testResults[env.id];
              return (
                <div
                  key={env.id}
                  className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{env.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {env.id}
                      </Badge>
                      {isActive && (
                        <Badge className="gap-1 text-[10px]">
                          <CheckCircle2 className="h-3 w-3" /> Active
                        </Badge>
                      )}
                      {!env.hasKey && (
                        <Badge variant="destructive" className="text-[10px]">
                          No key
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {env.base_url}
                    </p>
                    {test && (
                      <p
                        className={`mt-1 text-xs ${
                          test.ok ? "text-green-600 dark:text-green-400" : "text-destructive"
                        }`}
                      >
                        {test.ok ? "OK" : "Failed"}
                        {test.status ? ` (HTTP ${test.status})` : ""}
                        {" — "}
                        {test.message}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleTest(env.id)}
                      disabled={testing === env.id || !env.hasKey}
                    >
                      <Activity className="mr-1.5 h-4 w-4" />
                      {testing === env.id ? "Testing…" : "Test"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditing(env);
                        setDialogOpen(true);
                      }}
                    >
                      <Pencil className="mr-1.5 h-4 w-4" /> Edit
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" variant="outline" disabled={envs.length === 1}>
                          <Trash2 className="mr-1.5 h-4 w-4" /> Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove “{env.name}”?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This environment's URL and key will be deleted. AI calls
                            targeting it will stop working.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMut.mutate(env.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {data?.updated_at && (
          <p className="text-xs text-muted-foreground">
            Last updated {new Date(data.updated_at).toLocaleString()}
          </p>
        )}
      </Card>

      <EnvDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        existingIds={envs.map((e) => e.id)}
        onSave={async (payload) => {
          await upsertFn({ data: payload });
          toast.success(editing ? "Environment updated" : "Environment added");
          setDialogOpen(false);
          refetch();
        }}
      />
    </main>
  );
}

function EnvDialog({
  open,
  onOpenChange,
  editing,
  existingIds,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: EnvOut | null;
  existingIds: string[];
  onSave: (p: {
    env_id: string;
    name: string;
    base_url: string;
    api_key: string;
    make_active: boolean;
  }) => Promise<void>;
}) {
  const [envId, setEnvId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [makeActive, setMakeActive] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset when opening
  useState(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleOpen = (v: boolean) => {
    if (v) {
      setEnvId(editing?.id ?? "");
      setName(editing?.name ?? "");
      setBaseUrl(editing?.base_url ?? "");
      setApiKey("");
      setMakeActive(false);
    }
    onOpenChange(v);
  };

  const submit = async () => {
    setSaving(true);
    try {
      await onSave({
        env_id: envId.trim(),
        name: name.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey,
        make_active: makeActive,
      });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const isEdit = !!editing;
  const idCollision = !isEdit && existingIds.includes(envId.trim().toLowerCase());

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${editing.name}` : "Add environment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="env_id">ID</Label>
              <Input
                id="env_id"
                placeholder="dev, staging, prod"
                value={envId}
                onChange={(e) => setEnvId(e.target.value)}
                disabled={isEdit}
              />
              {idCollision && (
                <p className="text-xs text-destructive">ID already in use.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="env_name">Name</Label>
              <Input
                id="env_name"
                placeholder="Development"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="base_url">Base URL</Label>
            <Input
              id="base_url"
              placeholder="https://emergent.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="api_key" className="flex items-center gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> API key
            </Label>
            <Input
              id="api_key"
              type="password"
              placeholder={
                isEdit && editing.hasKey
                  ? "•••• (set) — leave blank to keep current key"
                  : "Paste API key"
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={makeActive}
              onCheckedChange={(v) => setMakeActive(v === true)}
            />
            Make this the active environment
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              saving ||
              !envId.trim() ||
              !name.trim() ||
              !baseUrl.trim() ||
              idCollision ||
              (!isEdit && !apiKey.trim())
            }
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
