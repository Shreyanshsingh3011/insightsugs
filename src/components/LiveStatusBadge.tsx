import { useEffect, useState } from "react";
import { Radio, WifiOff } from "lucide-react";
import type { LiveStatus } from "@/hooks/useLiveInvalidate";

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function LiveStatusBadge({
  status,
  label = "Live",
  className = "",
}: {
  status: LiveStatus;
  label?: string;
  className?: string;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const connected = status.connected;
  const ago = status.lastEventAt ? formatAgo(Date.now() - status.lastEventAt) : null;
  const title = connected
    ? ago
      ? `Realtime connected · last update ${ago}`
      : "Realtime connected · waiting for updates"
    : "Realtime disconnected — will reconnect automatically";

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        connected
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border-muted-foreground/30 bg-muted text-muted-foreground"
      } ${className}`}
    >
      {connected ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <Radio className="h-3 w-3" aria-hidden />
          <span>{label}</span>
          {ago && <span className="text-muted-foreground">· {ago}</span>}
        </>
      ) : (
        <>
          <WifiOff className="h-3 w-3" aria-hidden />
          <span>Offline</span>
        </>
      )}
    </span>
  );
}
