import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Sentinel URL stored on manually-created dependency sheets so we can find
// them again for future quick-adds (sheet_registry.apps_script_url is NOT
// NULL and is otherwise used to refresh from a Google Apps Script endpoint).
const MANUAL_URL = "manual://quick-dependencies";
const DISPLAY_NAME = "Quick Dependencies";

const InputSchema = z.object({
  activity: z.string().min(1).max(300),
  responsiblePerson: z.string().max(200).optional().default(""),
  responsibleEmail: z.string().email().max(200).optional().or(z.literal("")).default(""),
  department: z.string().max(120).optional().default(""),
  plannedEnd: z.string().max(40).optional().default(""),
  status: z.string().max(60).optional().default(""),
  remarks: z.string().max(1000).optional().default(""),
  project: z.string().max(120).optional().default(""),
});

async function findOrCreateManualSheet(
  supabase: any,
  userId: string,
): Promise<string> {
  const { data: existing, error: e1 } = await supabase
    .from("sheet_registry")
    .select("id")
    .eq("user_id", userId)
    .eq("apps_script_url", MANUAL_URL)
    .maybeSingle();
  if (e1) throw new Error(e1.message);
  if (existing?.id) return existing.id as string;

  const { data: reg, error: e2 } = await supabase
    .from("sheet_registry")
    .insert({
      user_id: userId,
      sheet_type: "generic",
      apps_script_url: MANUAL_URL,
      display_name: DISPLAY_NAME,
    })
    .select("id")
    .single();
  if (e2) throw new Error(e2.message);
  return reg.id as string;
}

/** Append a single dependency row to the user's Quick Dependencies sheet.
 * Dashboards, chatbot, and person rankings automatically include it because
 * they all read from sheet_rows on the next refresh. */
export const appendQuickDependency = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const registryId = await findOrCreateManualSheet(supabase, userId);

    const { data: last } = await supabase
      .from("sheet_rows")
      .select("row_index")
      .eq("sheet_registry_id", registryId)
      .order("row_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextIndex = ((last?.row_index as number | undefined) ?? -1) + 1;

    // Store both `canonical` (used by the dashboard normalizer) and `extras`
    // (used by the person resolver, which looks for the original header case
    // like "Responsible Person" / "Responsible Person Mail ID").
    const canonical: Record<string, string> = {
      activity: data.activity,
      status: data.status || "Yet to Start",
      planned_end: data.plannedEnd,
      dept: data.department,
      remarks: data.remarks,
      owner: data.responsiblePerson,
    };
    const extras: Record<string, string> = {
      "Responsible Person": data.responsiblePerson,
      "Responsible Person Mail ID": data.responsibleEmail,
      Project: data.project,
    };

    const { error: insErr } = await supabase.from("sheet_rows").insert({
      sheet_registry_id: registryId,
      row_index: nextIndex,
      canonical,
      extras,
    });
    if (insErr) throw new Error(insErr.message);

    const newCount = nextIndex + 1;
    await supabase
      .from("sheet_registry")
      .update({
        last_refreshed_at: new Date().toISOString(),
        row_count: newCount,
      })
      .eq("id", registryId);

    return { sheetId: registryId, rowIndex: nextIndex, rowCount: newCount };
  });
