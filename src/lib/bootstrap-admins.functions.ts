import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type BootstrapAdminRow = {
  id: string;
  email: string | null;
  user_id: string | null;
  note: string | null;
  created_at: string;
};

async function ensureSuper(context: any): Promise<void> {
  const { data: isSuper, error } = await context.supabase.rpc("has_role", {
    _user_id: context.userId,
    _role: "super_admin",
  });
  if (error) throw error;
  if (!isSuper) throw new Error("Forbidden: super_admin only");
}

export const listBootstrapAdmins = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BootstrapAdminRow[]> => {
    await ensureSuper(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("bootstrap_admins")
      .select("id, email, user_id, note, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as BootstrapAdminRow[];
  });

export const addBootstrapAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email?: string; user_id?: string; note?: string }) => ({
    email: d?.email ? String(d.email).trim().toLowerCase() : null,
    user_id: d?.user_id ? String(d.user_id).trim() : null,
    note: d?.note ? String(d.note).slice(0, 500) : null,
  }))
  .handler(async ({ data, context }): Promise<BootstrapAdminRow> => {
    await ensureSuper(context);
    if (!data.email && !data.user_id) throw new Error("Provide an email or a user_id");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("bootstrap_admins")
      .insert({
        email: data.email,
        user_id: data.user_id,
        note: data.note,
        created_by: context.userId,
      })
      .select("id, email, user_id, note, created_at")
      .single();
    if (error) throw error;
    const { refreshBootstrapSuperAdminsFromDb } = await import("@/lib/bootstrap-super-admins.server");
    await refreshBootstrapSuperAdminsFromDb(true);
    return row as BootstrapAdminRow;
  });

export const removeBootstrapAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: String(d?.id ?? "") }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await ensureSuper(context);
    if (!data.id) throw new Error("id required");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("bootstrap_admins").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
