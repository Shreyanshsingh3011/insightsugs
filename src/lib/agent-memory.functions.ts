// Server functions for per-user agent memory (Step 4).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AgentMemoryRow = {
  id: string;
  kind: string;
  key: string;
  value: string;
  importance: number;
  source: string | null;
  created_at: string;
  updated_at: string;
};

export const listAgentMemory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("agent_memory")
      .select("*")
      .eq("user_id", context.userId)
      .order("importance", { ascending: false })
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as AgentMemoryRow[];
  });

export const upsertAgentMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (raw: { kind: string; key: string; value: string; importance?: number; source?: string }) => ({
      kind: z.string().min(1).max(40).parse(raw.kind),
      key: z.string().min(1).max(120).parse(raw.key),
      value: z.string().min(1).max(1000).parse(raw.value),
      importance: Math.max(1, Math.min(raw.importance ?? 1, 5)),
      source: raw.source?.slice(0, 40) ?? "manual",
    }),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("agent_memory").upsert(
      {
        user_id: context.userId,
        kind: data.kind,
        key: data.key,
        value: data.value,
        importance: data.importance,
        source: data.source,
      },
      { onConflict: "user_id,kind,key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteAgentMemory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string }) => ({ id: z.string().uuid().parse(raw.id) }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("agent_memory")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
