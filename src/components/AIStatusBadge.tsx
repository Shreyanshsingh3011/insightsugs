import { useQuery } from "@tanstack/react-query";
import { Sparkles, AlertTriangle, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type HealthRow = {
  name: string;
  status: "ok" | "degraded" | "down";
  latency_ms: number | null;
  error: string | null;
  checked_at: string;
};

/**
 * Shows the active AI tier (Gateway / Gemini / Groq / unavailable) based on
 * the latest rows written to `integration_health` by the ai-health hook.
 */
export function AIStatusBadge({ className = "" }: { className?: string }) {
  const { data } = useQuery({
    queryKey: ["ai-status-badge"],
    refetchInterval: 60_000,
    queryFn: async (): Promise<HealthRow[]> => {
      const { data } = await supabase
        .from("integration_health")
        .select("name, status, latency_ms, error, checked_at")
        .in("name", ["ai.gateway", "ai.gemini", "ai.groq"])
        .order("checked_at", { ascending: false })
        .limit(30);
      return (data ?? []) as HealthRow[];
    },
  });

  const latest = new Map<string, HealthRow>();
  for (const row of data ?? []) if (!latest.has(row.name)) latest.set(row.name, row);
  const gw = latest.get("ai.gateway");
  const gm = latest.get("ai.gemini");
  const gr = latest.get("ai.groq");
  const active =
    gw?.status === "ok" ? { label: "AI: Gateway", tone: "ok" as const, ms: gw.latency_ms }
    : gm?.status === "ok" ? { label: "AI: Gemini", tone: "warn" as const, ms: gm.latency_ms }
    : gr?.status === "ok" ? { label: "AI: Groq", tone: "warn" as const, ms: gr.latency_ms }
    : { label: "AI unavailable", tone: "down" as const, ms: null };

  const cls =
    active.tone === "ok"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : active.tone === "warn"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400";

  const Icon = active.tone === "ok" ? Sparkles : active.tone === "warn" ? AlertTriangle : XCircle;
  const title = data
    ? `Gateway: ${gw?.status ?? "?"} · Gemini: ${gm?.status ?? "?"} · Groq: ${gr?.status ?? "?"}`
    : "AI status loading";

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${cls} ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{active.label}</span>
      {active.ms != null && <span className="text-muted-foreground">· {active.ms}ms</span>}
    </span>
  );
}
