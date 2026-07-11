import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RoleCheckResult = {
  email: string;
  found: boolean;
  userId: string | null;
  fullName: string | null;
  roles: string[];
  isSuperAdmin: boolean;
  checkedAt: string;
};

export const checkUserRoles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email: string }) => ({ email: String(d?.email ?? "").trim().toLowerCase() }))
  .handler(async ({ data, context }): Promise<RoleCheckResult> => {
    // Only super_admins may look up arbitrary users
    const { data: isSuper } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "super_admin",
    });
    if (!isSuper) throw new Error("Forbidden: super_admin only");

    const now = new Date().toISOString();
    if (!data.email) {
      return { email: "", found: false, userId: null, fullName: null, roles: [], isSuperAdmin: false, checkedAt: now };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: prof, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email")
      .ilike("email", data.email)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!prof) {
      return { email: data.email, found: false, userId: null, fullName: null, roles: [], isSuperAdmin: false, checkedAt: now };
    }

    const { data: roles, error: rErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", prof.id);
    if (rErr) throw rErr;

    const roleList = (roles ?? []).map((r: { role: string }) => r.role);
    return {
      email: prof.email ?? data.email,
      found: true,
      userId: prof.id,
      fullName: prof.full_name ?? null,
      roles: roleList,
      isSuperAdmin: roleList.includes("super_admin"),
      checkedAt: now,
    };
  });
