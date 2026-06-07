import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useIsSuper } from "@/hooks/useSession";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Plug, KeyRound, Save, Activity } from "lucide-react";
import {
  getEmergentConfig,
  saveEmergentConfig,
  testEmergentConnection,
} from "@/lib/integrations.functions";

export const Route = createFileRoute("/_authenticated/admin/integrations")({
  head: () => ({ meta: [{ title: "Integrations — DelayLens" }] }),
  component: IntegrationsPage,
});

function IntegrationsPage() {
  const isSuper = useIsSuper();
  const getFn = useServerFn(getEmergentConfig);
  const saveFn = useServerFn(saveEmergentConfig);
  const testFn = useServerFn(testEmergentConnection);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["emergent-config"],
    queryFn: () => getFn(),
    enabled: isSuper,
  });

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number; message: string } | null>(null);

  useEffect(() => {
    if (data) setBaseUrl(data.base_url ?? "");
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () => saveFn({ data: { base_url: baseUrl, api_key: apiKey } }),
    onSuccess: () => {
      toast.success("Integration saved");
      setApiKey("");
      refetch();
    },
    onError: (e: any) => toast.error(e?.message ?? "Save failed"),
  });

  const testMut = useMutation({
    mutationFn: () => testFn(),
    onSuccess: (r: any) => setTestResult(r),
    onError: (e: any) => setTestResult({ ok: false, status: 0, message: e?.message ?? "Test failed" }),
  });

  if (!isSuper) {
    throw redirect({ to: "/dashboard" });
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 md:px-6">
      <header className="mb-6">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Plug className="h-5 w-5 text-primary" /> Integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Connect external services that power AI features in DelayLens.
        </p>
      </header>

      <Card className="space-y-5 border-border bg-card p-5">
        <div>
          <h2 className="text-sm font-semibold">Emergent AI service</h2>
          <p className="text-xs text-muted-foreground">
            All AI mapping, dependency inference, and Copilot calls route through this service.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="base_url">Base URL</Label>
          <Input
            id="base_url"
            placeholder="https://emergent.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="api_key" className="flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" /> API key
          </Label>
          <Input
            id="api_key"
            type="password"
            placeholder={data?.hasKey ? "•••• (set) — leave blank to keep current key" : "Paste API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={isLoading}
            autoComplete="new-password"
          />
          <p className="text-xs text-muted-foreground">
            Submitting blank preserves the existing key. The stored key is never sent back to the browser.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !baseUrl.trim()}>
            <Save className="mr-1.5 h-4 w-4" />
            {saveMut.isPending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="outline"
            onClick={() => testMut.mutate()}
            disabled={testMut.isPending || !data?.hasKey}
          >
            <Activity className="mr-1.5 h-4 w-4" />
            {testMut.isPending ? "Testing…" : "Test connection"}
          </Button>
        </div>

        {testResult && (
          <div
            className={`rounded-md border p-3 text-xs ${
              testResult.ok
                ? "border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-300"
                : "border-destructive/30 bg-destructive/5 text-destructive"
            }`}
          >
            <div className="font-medium">
              {testResult.ok ? "Connected" : "Failed"} {testResult.status ? `(HTTP ${testResult.status})` : ""}
            </div>
            <div className="mt-1 break-all">{testResult.message}</div>
          </div>
        )}

        {data?.updated_at && (
          <p className="text-xs text-muted-foreground">
            Last updated {new Date(data.updated_at).toLocaleString()}
          </p>
        )}
      </Card>
    </main>
  );
}
