import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { isRecoverableDataReadError, isTransientDataApiError } from "@/lib/transient-errors";
import type { Database } from "@/integrations/supabase/types";

export type Assignment = {
  id: string;
  project_key: string;
  project_label: string;
  is_leader: boolean;
};

export const listMyAssignments = createServerFn({ method: "POST" })
  .handler(async () => {
    const authHeader = getRequestHeader("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    if (!token) return { assignments: [] as Assignment[], degraded: true, reason: "missing_auth" };

    const supabaseUrl = process.env.SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !publishableKey) {
      return { assignments: [] as Assignment[], degraded: true, reason: "backend_not_configured" };
    }

    const supabase = createClient<Database>(supabaseUrl, publishableKey, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user?.id) {
        console.warn("Project assignment lookup skipped: invalid or unavailable auth token.", userError?.message);
        return { assignments: [] as Assignment[], degraded: true, reason: "invalid_auth" };
      }
      const { data, error } = await supabase
        .from("user_project_assignments")
        .select("id, project_key, project_label, is_leader")
        .eq("user_id", userData.user.id)
        .order("project_label");
      if (error) throw error;
      return { assignments: (data ?? []) as Assignment[] };
    } catch (error) {
      if (isRecoverableDataReadError(error)) {
        console.warn("Project assignment lookup failed temporarily; continuing with an empty assignment list.", error);
        return { assignments: [] as Assignment[], degraded: true };
      }
      throw new Error(error instanceof Error ? error.message : "Unable to load project assignments");
    }
  });

export const saveMyAssignments = createServerFn({ method: "POST" })
  .inputValidator((d: { projects: { key: string; label: string }[] }) => d)
  .handler(async ({ data }) => {
    const authHeader = getRequestHeader("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
    if (!token) return { ok: false, degraded: true, reason: "missing_auth" };

    const supabaseUrl = process.env.SUPABASE_URL;
    const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !publishableKey) return { ok: false, degraded: true, reason: "backend_not_configured" };

    const supabase = createClient<Database>(supabaseUrl, publishableKey, {
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user?.id) {
        console.warn("Project assignment save skipped: invalid or unavailable auth token.", userError?.message);
        return { ok: false, degraded: true, reason: "invalid_auth" };
      }
      const keys = data.projects.map((p) => p.key);
      const labels = data.projects.map((p) => p.label);
      const { error } = await supabase.rpc("set_my_project_assignments", {
        _keys: keys,
        _labels: labels,
      });
      if (error) throw error;
      return { ok: true };
    } catch (error) {
      if (isTransientDataApiError(error) || isRecoverableDataReadError(error)) {
        console.warn("Project assignment save failed temporarily; keeping the existing assignment list.", error);
        return { ok: false, degraded: true };
      }
      throw new Error(error instanceof Error ? error.message : "Unable to save project assignments");
    }
  });
