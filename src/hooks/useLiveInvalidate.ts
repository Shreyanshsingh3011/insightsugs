import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Subscribe to Postgres change events on the given tables and invalidate the
 * matching react-query keys whenever any row changes. Debounced so a burst of
 * sync writes only triggers one refetch per key.
 */
export function useLiveInvalidate(
  tables: string[],
  queryKeys: readonly (readonly unknown[])[],
  channelName?: string,
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!tables.length || !queryKeys.length) return;
    const name = channelName ?? `live:${tables.join(",")}`;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const key of queryKeys) {
          qc.invalidateQueries({ queryKey: key as unknown[] });
        }
      }, 400);
    };

    const channel = supabase.channel(name);
    for (const table of tables) {
      (channel as unknown as { on: (t: string, f: Record<string, string>, cb: () => void) => void }).on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        schedule,
      );

    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, tables.join("|"), channelName]);
}
