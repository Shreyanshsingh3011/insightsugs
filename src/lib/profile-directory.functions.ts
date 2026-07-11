import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ProfileDirectoryEntry = { email: string; full_name: string };

/** Returns every profile's email → full_name pair so the client can map
 * a Responsible-Person-Mail-ID from a sheet back to the human's real name. */
export const getProfileDirectory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ entries: ProfileDirectoryEntry[] }> => {
    try {
      const { data, error } = await context.supabase
        .from("profiles")
        .select("email, full_name");
      if (error) throw error;
      const entries = (data ?? [])
        .map((r) => ({
          email: String(r.email ?? "").trim().toLowerCase(),
          full_name: String(r.full_name ?? "").trim(),
        }))
        .filter((r) => r.email && r.full_name);
      return { entries };
    } catch (error) {
      console.warn("Profile directory lookup failed; continuing without name mapping.", error);
      return { entries: [] };
    }
  });
