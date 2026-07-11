import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isTransientDataApiError } from "@/lib/transient-errors";

export type Assignment = {
  id: string;
  project_key: string;
  project_label: string;
  is_leader: boolean;
};

export const listMyAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    try {
      const { data, error } = await supabase
        .from("user_project_assignments")
        .select("id, project_key, project_label, is_leader")
        .eq("user_id", userId)
        .order("project_label");
      if (error) throw error;
      return { assignments: (data ?? []) as Assignment[] };
    } catch (error) {
      if (isTransientDataApiError(error)) {
        console.warn("Project assignment lookup failed temporarily; continuing with an empty assignment list.", error);
        return { assignments: [] as Assignment[], degraded: true };
      }
      throw new Error(error instanceof Error ? error.message : "Unable to load project assignments");
    }
  });

export const saveMyAssignments = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projects: { key: string; label: string }[] }) => d)
  .handler(async ({ data, context }) => {
    const { supabase } = context as { supabase: any };
    const keys = data.projects.map((p) => p.key);
    const labels = data.projects.map((p) => p.label);
    const { error } = await supabase.rpc("set_my_project_assignments", {
      _keys: keys,
      _labels: labels,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
