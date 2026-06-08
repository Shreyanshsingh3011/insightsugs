import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { invalidateEmergentCache, pingEmergent } from "./emergent-client";

type EnvRow = { id: string; name: string; base_url: string; api_key: string };

async function assertSuper(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "super_admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Only super admins can manage integrations.");
}

async function loadRow() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("integrations" as any)
    .select("base_url, api_key, environments, active_env, updated_at")
    .eq("key", "emergent")
    .maybeSingle();
  return data as
    | {
        base_url?: string;
        api_key?: string;
        environments?: EnvRow[] | null;
        active_env?: string | null;
        updated_at?: string;
      }
    | null;
}

function normalizeEnvs(row: Awaited<ReturnType<typeof loadRow>>): {
  envs: EnvRow[];
  active: string | null;
} {
  let envs = Array.isArray(row?.environments) ? [...(row!.environments as EnvRow[])] : [];
  if (envs.length === 0 && row?.base_url) {
    envs = [{ id: "prod", name: "Production", base_url: row.base_url, api_key: row.api_key ?? "" }];
  }
  let active = row?.active_env ?? null;
  if (!active || !envs.some((e) => e.id === active)) active = envs[0]?.id ?? null;
  return { envs, active };
}

export const getEmergentConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const row = await loadRow();
    const { envs, active } = normalizeEnvs(row);
    return {
      environments: envs.map((e) => ({
        id: e.id,
        name: e.name,
        base_url: e.base_url,
        hasKey: !!(e.api_key && e.api_key.length > 0),
      })),
      active_env: active,
      updated_at: row?.updated_at ?? null,
    };
  });

const upsertSchema = z.object({
  env_id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_-]+$/i, "Use letters, numbers, dashes or underscores"),
  name: z.string().trim().min(1).max(60),
  base_url: z.string().trim().url().max(500),
  api_key: z.string().max(500),
  make_active: z.boolean().optional(),
});

export const upsertEmergentEnv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: z.infer<typeof upsertSchema>) => upsertSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const row = await loadRow();
    const { envs, active } = normalizeEnvs(row);
    const id = data.env_id.toLowerCase();
    const existing = envs.find((e) => e.id === id);
    const trimmedKey = data.api_key.trim();
    const apiKey = trimmedKey.length > 0 ? trimmedKey : existing?.api_key ?? "";
    const next: EnvRow = {
      id,
      name: data.name.trim(),
      base_url: data.base_url.trim(),
      api_key: apiKey,
    };
    const updated = existing
      ? envs.map((e) => (e.id === id ? next : e))
      : [...envs, next];
    const nextActive = data.make_active ? id : active ?? id;
    const activeRow = updated.find((e) => e.id === nextActive) ?? updated[0];

    const { error } = await supabaseAdmin.from("integrations" as any).upsert(
      {
        key: "emergent",
        environments: updated,
        active_env: activeRow?.id ?? null,
        base_url: activeRow?.base_url ?? "",
        api_key: activeRow?.api_key ?? "",
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    invalidateEmergentCache();
    return { ok: true };
  });

export const deleteEmergentEnv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { env_id: string }) =>
    z.object({ env_id: z.string().trim().min(1).max(40) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const row = await loadRow();
    const { envs, active } = normalizeEnvs(row);
    const updated = envs.filter((e) => e.id !== data.env_id);
    const nextActive =
      active === data.env_id ? updated[0]?.id ?? null : active;
    const activeRow = updated.find((e) => e.id === nextActive);
    const { error } = await supabaseAdmin.from("integrations" as any).upsert(
      {
        key: "emergent",
        environments: updated,
        active_env: nextActive,
        base_url: activeRow?.base_url ?? "",
        api_key: activeRow?.api_key ?? "",
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    invalidateEmergentCache();
    return { ok: true };
  });

export const setActiveEmergentEnv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { env_id: string }) =>
    z.object({ env_id: z.string().trim().min(1).max(40) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const row = await loadRow();
    const { envs } = normalizeEnvs(row);
    const activeRow = envs.find((e) => e.id === data.env_id);
    if (!activeRow) throw new Error("Environment not found.");
    const { error } = await supabaseAdmin.from("integrations" as any).upsert(
      {
        key: "emergent",
        environments: envs,
        active_env: activeRow.id,
        base_url: activeRow.base_url,
        api_key: activeRow.api_key,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message);
    invalidateEmergentCache();
    return { ok: true };
  });

export const testEmergentConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { env_id?: string } | undefined) =>
    z
      .object({ env_id: z.string().trim().min(1).max(40).optional() })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    return await pingEmergent(data.env_id);
  });

// Back-compat: old single save endpoint -> upserts the active env or "prod".
export const saveEmergentConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { base_url: string; api_key: string }) =>
    z
      .object({ base_url: z.string().trim().url().max(500), api_key: z.string().max(500) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const row = await loadRow();
    const { active } = normalizeEnvs(row);
    const id = active ?? "prod";
    return await (upsertEmergentEnv as any)({
      data: {
        env_id: id,
        name: id === "prod" ? "Production" : id,
        base_url: data.base_url,
        api_key: data.api_key,
        make_active: true,
      },
    });
  });
