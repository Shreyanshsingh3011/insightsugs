import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listMyBriefings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("weekly_briefings")
      .select("id, scope, week_start, week_end, created_at, user_id")
      .or(`user_id.eq.${userId},scope.eq.org`)
      .order("week_start", { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getBriefing = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: row, error } = await supabase
      .from("weekly_briefings")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Briefing not found");
    return row;
  });

const SECTIONS = ["projects", "sheets", "documents", "alerts"] as const;
const PRIORITIES = ["top", "by_due_date", "by_age"] as const;

export const getMyBriefingPreferences = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("briefing_preferences")
      .select("sections, overdue_priority")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (
      data ?? {
        sections: [...SECTIONS] as string[],
        overdue_priority: "top" as (typeof PRIORITIES)[number],
      }
    );
  });

export const saveMyBriefingPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        sections: z.array(z.enum(SECTIONS)).min(1),
        overdue_priority: z.enum(PRIORITIES),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("briefing_preferences")
      .upsert(
        { user_id: userId, sections: data.sections, overdue_priority: data.overdue_priority },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

