// CRUD server fns for user-defined custom agents (Step 8).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
type Json = string | number | boolean | null | { [k: string]: Json } | Json[];


export type CustomAgent = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  system_prompt: string;
  tool_allowlist: string[];
  active: boolean;
  webhook_secret: string;
  webhook_enabled: boolean;
  last_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
};

export type WebhookEvent = {
  id: string;
  agent_id: string;
  source_ip: string | null;
  payload: Json;
  status: string;
  run_id: string | null;
  output: string | null;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
};

export const listCustomAgents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("custom_agents")
      .select("*")
      .eq("owner_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as CustomAgent[];
  });

export const createCustomAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { name: string; description?: string; system_prompt: string; tool_allowlist?: string[] }) => ({
    name: z.string().min(1).max(80).parse(raw.name),
    description: raw.description?.slice(0, 300) ?? null,
    system_prompt: z.string().min(1).max(4000).parse(raw.system_prompt),
    tool_allowlist: (raw.tool_allowlist ?? []).slice(0, 20),
  }))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("custom_agents")
      .insert({
        owner_id: context.userId,
        name: data.name,
        description: data.description,
        system_prompt: data.system_prompt,
        tool_allowlist: data.tool_allowlist,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const updateCustomAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: {
    id: string;
    name?: string;
    description?: string;
    system_prompt?: string;
    tool_allowlist?: string[];
    active?: boolean;
    webhook_enabled?: boolean;
  }) => ({
    id: z.string().uuid().parse(raw.id),
    patch: {
      ...(raw.name != null ? { name: raw.name.slice(0, 80) } : {}),
      ...(raw.description != null ? { description: raw.description.slice(0, 300) } : {}),
      ...(raw.system_prompt != null ? { system_prompt: raw.system_prompt.slice(0, 4000) } : {}),
      ...(raw.tool_allowlist ? { tool_allowlist: raw.tool_allowlist.slice(0, 20) } : {}),
      ...(typeof raw.active === "boolean" ? { active: raw.active } : {}),
      ...(typeof raw.webhook_enabled === "boolean" ? { webhook_enabled: raw.webhook_enabled } : {}),
    },
  }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("custom_agents")
      .update(data.patch)
      .eq("id", data.id)
      .eq("owner_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const rotateWebhookSecret = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string }) => ({ id: z.string().uuid().parse(raw.id) }))
  .handler(async ({ data, context }) => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await context.supabase
      .from("custom_agents")
      .update({ webhook_secret: secret })
      .eq("id", data.id)
      .eq("owner_id", context.userId);
    if (error) throw new Error(error.message);
    return { secret };
  });

export const deleteCustomAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { id: string }) => ({ id: z.string().uuid().parse(raw.id) }))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("custom_agents")
      .delete()
      .eq("id", data.id)
      .eq("owner_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listWebhookEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { agent_id: string; limit?: number }) => ({
    agent_id: z.string().uuid().parse(raw.agent_id),
    limit: Math.min(Math.max(raw.limit ?? 50, 1), 200),
  }))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("webhook_events")
      .select("*")
      .eq("agent_id", data.agent_id)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw new Error(error.message);
    return (rows ?? []) as WebhookEvent[];
  });
