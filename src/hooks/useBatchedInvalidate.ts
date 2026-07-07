import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Coalesces query invalidations triggered by high-frequency events
 * (e.g. Realtime postgres_changes bursts).
 *
 * - De-dupes identical query keys within the window.
 * - Flushes once per `windowMs` (default 250ms).
 * - Skips flush while the tab is hidden; runs once when it becomes visible.
 * - Uses `refetchType: "active"` so only mounted queries refetch, not every
 *   cached filter/status variant.
 */
export function useBatchedInvalidate(windowMs = 250) {
  const qc = useQueryClient();
  const pending = useRef<Map<string, QueryKey>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasHidden = useRef(false);

  const flush = useMemo(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (typeof document !== "undefined" && document.hidden) {
        wasHidden.current = true;
        return;
      }
      const keys = Array.from(pending.current.values());
      pending.current.clear();
      for (const key of keys) {
        qc.invalidateQueries({ queryKey: key, refetchType: "active" });
      }
    },
    [qc],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (!document.hidden && (wasHidden.current || pending.current.size > 0)) {
        wasHidden.current = false;
        flush();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [flush]);

  return useMemo(
    () => (key: QueryKey) => {
      const id = JSON.stringify(key);
      pending.current.set(id, key);
      if (timer.current) return;
      timer.current = setTimeout(flush, windowMs);
    },
    [flush, windowMs],
  );
}
