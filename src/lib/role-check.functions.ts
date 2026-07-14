import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isRecoverableDataReadError } from "@/lib/transient-errors";
import type { Database } from "@/integrations/supabase/types";
import {
  applyBootstrapSuperAdminRole,
  emailFromJwtPayload,
  isBootstrapSuperAdminEmail,
  isBootstrapSuperAdminUserId,
  readJwtPayload,
} from "@/lib/bootstrap-super-admins";

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
    const authHeader = getRequestHeader("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    const payload = readJwtPayload(token);
    let userId = String((context as any).userId ?? payload?.sub ?? "");
    let userEmail =
      String((context as any).claims?.email ?? "").trim().toLowerCase() || emailFromJwtPayload(payload);
    if (isBootstrapSuperAdminUserId(userId)) {
      return { roles: ["super_admin"], degraded: false };
    }
    if (userEmail && isBootstrapSuperAdminEmail(userEmail)) {
      return { roles: ["super_admin"], degraded: false };
    }
    if (!token || !userId) return { roles: [], degraded: true };

    const supabaseUrl = process.env.SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !publishableKey) return { roles: ["user"], degraded: true };

    const supabase = createClient<Database>(supabaseUrl, publishableKey, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    let lastError: unknown = null;

    try {
      const claimsResult = await Promise.race([
        supabase.auth.getClaims(token),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      const claims = claimsResult?.data?.claims;
      if (claimsResult?.error || !claims?.sub) {
        console.warn("Role lookup continuing with middleware-validated identity; auth claims endpoint unavailable.", claimsResult?.error?.message);
      } else {
        userId = claims.sub;
        userEmail =
          (typeof claims.email === "string" ? claims.email : "").trim().toLowerCase() ||
          userEmail ||
          emailFromJwtPayload(payload);
      }
      if (isBootstrapSuperAdminEmail(userEmail)) {
        return { roles: ["super_admin"], degraded: false };
      }
    } catch (error) {
      console.warn("Role lookup continuing with middleware-validated identity; auth validation unavailable.", error);
      if (isBootstrapSuperAdminEmail(userEmail)) {
        return { roles: ["super_admin"], degraded: false };
      }
    }

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
      const adminEmail = authUser.user?.email?.trim().toLowerCase();
      if (adminEmail) userEmail = adminEmail;
      if (isBootstrapSuperAdminEmail(userEmail)) {
        return { roles: ["super_admin"], degraded: false };
      }
      const { data, error } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId);
      if (error) throw error;
      const roles = (data ?? []).map((r: { role: string }) => r.role);
      const recoveredRoles = applyBootstrapSuperAdminRole(roles, userEmail, userId);
      if (recoveredRoles.length > 0) return { roles: recoveredRoles, degraded: true };
    } catch (error) {
      lastError = error;
    }

    for (const waitMs of [0, 250]) {
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      try {
        const { data, error } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId);
        if (error) throw error;
        return { roles: applyBootstrapSuperAdminRole((data ?? []).map((r: { role: string }) => r.role), userEmail, userId), degraded: true };
      } catch (error) {
        lastError = error;
        if (!isRecoverableDataReadError(error)) throw error;
      }
    }

    if (isBootstrapSuperAdminEmail(userEmail) || isBootstrapSuperAdminUserId(userId)) {
      console.warn("Role lookup recovered through bootstrap super-admin mapping during backend grant outage.");
      return { roles: ["super_admin"], degraded: true };
    }

    console.warn("Role lookup failed after retries; rendering user-level workspace.", lastError);
    return { roles: ["user"], degraded: true };
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
