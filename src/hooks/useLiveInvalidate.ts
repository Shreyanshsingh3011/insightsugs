import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type LiveStatus = {
  connected: boolean;
  lastEventAt: number | null;
};

/**
 * Subscribe to Postgres change events on the given tables and invalidate the
 * matching react-query keys whenever any row changes. Returns a live status
 * object suitable for a small UI indicator (connected + last event time).
 */
export function useLiveInvalidate(
  tables: string[],
  queryKeys: readonly (readonly unknown[])[],
  channelName?: string,
): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>({ connected: false, lastEventAt: null });

  useEffect(() => {
    if (!tables.length || !queryKeys.length) return;
    const name = channelName ?? `live:${tables.join(",")}`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      setStatus((s) => ({ connected: s.connected, lastEventAt: Date.now() }));
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of queryKeys) {
          qc.invalidateQueries({ queryKey: key as unknown[] });
        }
      }, 400);
    };

    const channel = supabase.channel(name);
    const chanOn = channel as unknown as {
      on: (t: string, f: Record<string, string>, cb: () => void) => void;
    };
    for (const table of tables) {
      chanOn.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        schedule,
      );
    }
    channel.subscribe((state: string) => {
      setStatus((s) => ({ ...s, connected: state === "SUBSCRIBED" }));
    });

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
      setStatus({ connected: false, lastEventAt: null });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, tables.join("|"), channelName]);

  return status;
}
