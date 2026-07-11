import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isRecoverableDataReadError } from "@/lib/transient-errors";

export type RoleCheckResult = {
  email: string;
  found: boolean;
  userId: string | null;
  fullName: string | null;
  roles: string[];
  isSuperAdmin: boolean;
  checkedAt: string;
};

export type MyRolesResult = {
  roles: string[];
  degraded?: boolean;
};

export const getMyRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyRolesResult> => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    let lastError: unknown = null;

    for (const waitMs of [0, 350, 900]) {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        const { data, error } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId);
        if (error) throw error;
        return { roles: (data ?? []).map((r: { role: string }) => r.role) };
      } catch (error) {
        lastError = error;
        if (!isRecoverableDataReadError(error)) throw error;
      }
    }

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      if (error) throw error;
      return { roles: (data ?? []).map((r: { role: string }) => r.role), degraded: true };
    } catch (error) {
      console.warn("Role lookup failed after retries; rendering user-level workspace.", error || lastError);
      return { roles: ["user"], degraded: true };
    }
  });

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
