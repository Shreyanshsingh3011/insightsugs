import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useRoles } from "@/hooks/useSession";
import { Button } from "@/components/ui/button";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useLiveInvalidate } from "@/hooks/useLiveInvalidate";
import { LiveStatusBadge } from "@/components/LiveStatusBadge";

export const Route = createFileRoute("/_authenticated/admin/health")({
  component: HealthPage,
  head: () => ({
    meta: [
      { title: "Admin — Integration health" },
      { name: "robots", content: "noindex" },
    ],
  }),
});

type Row = {
  id: string;
  name: string;
  status: "ok" | "degraded" | "down";
  latency_ms: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  checked_at: string;
};

const KNOWN = [
  { key: "ai.gateway", label: "AI · Lovable Gateway" },
  { key: "ai.gemini", label: "AI · Gemini (fallback)" },
  { key: "ai.groq", label: "AI · Groq (fallback)" },
  { key: "ai.embeddings", label: "AI · Embeddings" },
  { key: "sheets.sync", label: "Google Sheets sync" },
  { key: "resend.outbound", label: "Resend · Outbound" },
  { key: "resend.inbound", label: "Resend · Inbound" },
  { key: "realtime", label: "Supabase Realtime" },
];

function toneCls(s: string) {
  if (s === "ok") return "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400";
  if (s === "degraded") return "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400";
  return "bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-400";
}

function HealthPage() {
  const { data: roles } = useRoles();
  const isAdmin = !!roles?.some((r) => r === "admin" || r === "super_admin");
  const qc = useQueryClient();
  const live = useLiveInvalidate(["integration_health"], [["integration-health"]], "live:integration-health");

  const q = useQuery({
    queryKey: ["integration-health"],
    enabled: isAdmin,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Row[]> => {
      const { data } = await supabase
        .from("integration_health")
        .select("id, name, status, latency_ms, error, meta, checked_at")
        .order("checked_at", { ascending: false })
        .limit(200);
      return (data ?? []) as Row[];
    },
  });

  const probe = useMutation({
    mutationFn: async () => {
      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      const res = await fetch("/api/public/hooks/ai-health", { headers: { apikey } });
      if (!res.ok) throw new Error(`probe failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["integration-health"] }),
  });

  if (!isAdmin) {
    return (
      <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
        <ShieldAlert className="h-4 w-4" /> Admins only.
      </div>
    );
  }

  const latest = new Map<string, Row>();
  for (const r of q.data ?? []) if (!latest.has(r.name)) latest.set(r.name, r);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Integration health</h1>
          <p className="text-sm text-muted-foreground">
            Rolling status for AI providers, sheet sync, email, and realtime.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LiveStatusBadge status={live} />
          <Button size="sm" variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${probe.isPending ? "animate-spin" : ""}`} />
            Run probe now
          </Button>
        </div>
      </header>

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {KNOWN.map(({ key, label }) => {
          const r = latest.get(key);
          const status = r?.status ?? "unknown";
          return (
            <div key={key} className={`rounded-lg border p-3 ${r ? toneCls(status) : "border-dashed text-muted-foreground"}`}>
              <div className="flex items-center justify-between">
                <div className="font-medium text-sm">{label}</div>
                <span className="text-xs uppercase tracking-wide">{status}</span>
              </div>
              <div className="mt-1 text-xs opacity-80">
                {r ? (
                  <>
                    {r.latency_ms != null && <span>{r.latency_ms}ms</span>}
                    {r.checked_at && <span className="ml-2">· {new Date(r.checked_at).toLocaleTimeString()}</span>}
                  </>
                ) : (
                  "no data yet"
                )}
              </div>
              {r?.error && <div className="mt-1 text-xs opacity-80 line-clamp-2">{r.error}</div>}
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="text-lg font-medium mb-2">Recent history</h2>
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">When</th>
                <th className="text-left px-3 py-2">Integration</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Latency</th>
                <th className="text-left px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).slice(0, 60).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-1.5 text-xs">{new Date(r.checked_at).toLocaleString()}</td>
                  <td className="px-3 py-1.5">{r.name}</td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-xs border ${toneCls(r.status)}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-xs">{r.latency_ms ?? "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground truncate max-w-[280px]">{r.error ?? ""}</td>
                </tr>
              ))}
              {!q.data?.length && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No probes recorded yet — click “Run probe now”.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
