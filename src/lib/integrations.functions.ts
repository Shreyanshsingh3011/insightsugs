import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { invalidateEmergentCache, pingEmergent } from "./emergent-client";

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

export const getEmergentConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("integrations" as any)
      .select("base_url, api_key, updated_at")
      .eq("key", "emergent")
      .maybeSingle();
    const row = data as { base_url?: string; api_key?: string; updated_at?: string } | null;
    return {
      base_url: row?.base_url ?? "",
      hasKey: !!(row?.api_key && row.api_key.length > 0),
      updated_at: row?.updated_at ?? null,
    };
  });

export const saveEmergentConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { base_url: string; api_key: string }) =>
    z
      .object({
        base_url: z.string().trim().url().max(500),
        api_key: z.string().max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: existing } = await supabaseAdmin
      .from("integrations" as any)
      .select("api_key")
      .eq("key", "emergent")
      .maybeSingle();

    const trimmedKey = data.api_key.trim();
    const preservedKey =
      trimmedKey.length > 0 ? trimmedKey : (existing as any)?.api_key ?? "";

    const { error } = await supabaseAdmin.from("integrations" as any).upsert(
      {
        key: "emergent",
        base_url: data.base_url.trim(),
        api_key: preservedKey,
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
  .handler(async ({ context }) => {
    const { supabase, userId } = context as any;
    await assertSuper(supabase, userId);
    return await pingEmergent();
  });
