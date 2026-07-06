import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type SeededLogin = {
  email: string;
  full_name: string;
  role: "super_admin" | "admin" | "user";
  password: string;
  status: "ok" | "error";
  message?: string;
};

const DEFAULT_PASSWORD = "DelayLens#2026";

// A "real" email = has a real-looking domain (not a test/synthetic placeholder).
function isRealEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false;
  const domain = e.split("@")[1] ?? "";
  if (domain.endsWith(".test")) return false;
  if (domain === "test.com" || domain === "example.com" || domain === "example.org") return false;
  return true;
}

/**
 * Seed / reset test logins ONLY for real emails that already exist in the
 * project (profiles table + auth.users). Never touches synthetic *.test users.
 *
 * - Requires super_admin.
 * - Resets each real user's password to a shared, well-known test password.
 * - Keeps existing role if present; otherwise assigns 'user'.
 * - Returns the credentials the caller can copy for QA.
 */
export const seedTestLoginsFromRealEmails = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => {
    const d = (raw ?? {}) as { password?: string; includeGmail?: boolean };
    return {
      password: typeof d.password === "string" && d.password.length >= 8 ? d.password : DEFAULT_PASSWORD,
      includeGmail: d.includeGmail !== false, // default true
    };
  })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }): Promise<{ password: string; logins: SeededLogin[] }> => {
    const { supabase, userId } = context;

    // Super-admin gate (defence in depth on top of RLS).
    const { data: roleRows, error: roleErr } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    if (roleErr) throw new Error(roleErr.message);
    const isSuper = (roleRows ?? []).some((r) => r.role === "super_admin");
    if (!isSuper) throw new Error("Only super admins can seed test logins");

    // Pull profiles + roles. RLS on profiles allows super_admin to read all.
    const [{ data: profiles, error: pErr }, { data: allRoles, error: rErr }] = await Promise.all([
      supabase.from("profiles").select("id, email, full_name"),
      supabase.from("user_roles").select("user_id, role"),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (rErr) throw new Error(rErr.message);

    const roleByUser = new Map<string, "super_admin" | "admin" | "user">();
    (allRoles ?? []).forEach((r) => {
      const cur = roleByUser.get(r.user_id);
      // Prefer highest-privilege existing role for display.
      const rank = { user: 0, admin: 1, super_admin: 2 } as const;
      if (!cur || rank[r.role as keyof typeof rank] > rank[cur]) {
        roleByUser.set(r.user_id, r.role as "super_admin" | "admin" | "user");
      }
    });

    const targets = (profiles ?? []).filter((p) => {
      if (!isRealEmail(p.email)) return false;
      const domain = (p.email ?? "").toLowerCase().split("@")[1] ?? "";
      if (!data.includeGmail && domain === "gmail.com") return false;
      return true;
    });

    if (targets.length === 0) {
      return { password: data.password, logins: [] };
    }

    // Load admin client only on server.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const logins: SeededLogin[] = [];
    for (const p of targets) {
      const role = roleByUser.get(p.id) ?? "user";
      try {
        const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(p.id, {
          password: data.password,
          email_confirm: true,
        });
        if (updErr) throw new Error(updErr.message);

        // Ensure at least a 'user' role row exists so the app can sign them in.
        if (!roleByUser.has(p.id)) {
          await supabaseAdmin
            .from("user_roles")
            .insert({ user_id: p.id, role: "user" })
            .then(() => undefined);
        }

        // Mark any pending signup as approved so they don't hit the pending screen.
        await supabaseAdmin
          .from("signup_requests")
          .update({
            status: "approved",
            verified_via: "admin",
            granted_role: role,
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
          })
          .eq("user_id", p.id)
          .eq("status", "pending")
          .then(() => undefined);

        logins.push({
          email: p.email!,
          full_name: p.full_name ?? "",
          role,
          password: data.password,
          status: "ok",
        });
      } catch (e) {
        logins.push({
          email: p.email!,
          full_name: p.full_name ?? "",
          role,
          password: data.password,
          status: "error",
          message: (e as Error).message,
        });
      }
    }

    // Sort: super_admin first, then admin, then user, then by email.
    const rank = { super_admin: 0, admin: 1, user: 2 } as const;
    logins.sort((a, b) => rank[a.role] - rank[b.role] || a.email.localeCompare(b.email));

    return { password: data.password, logins };
  });
