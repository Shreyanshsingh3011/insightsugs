import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { computeReconciliation, type ReconciliationSummary } from "./reconciliation";

const InputSchema = z.object({
  sheetIds: z.array(z.string().uuid()).max(20).optional(),
});

export const computeReconciliationForUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input ?? {}))
  .handler(async ({ data, context }): Promise<{
    summary: ReconciliationSummary | null;
    sheetLabel: string | null;
    sheetId: string | null;
    consideredSheets: { id: string; label: string; matchScore: number }[];
  }> => {
    const { supabase, userId } = context;

    // Find sheets the user can read, prefer material_reconciliation-typed ones.
    let query = supabase
      .from("sheet_registry")
      .select("id, display_name, sheet_type")
      .eq("user_id", userId)
      .limit(20);
    if (data.sheetIds?.length) query = query.in("id", data.sheetIds);
    const { data: regs, error } = await query;
    if (error) throw new Error(error.message);
    if (!regs?.length) return { summary: null, sheetLabel: null, sheetId: null, consideredSheets: [] };

    // Score candidates by material_reconciliation shape or col-name hints.
    const scored: { id: string; label: string; matchScore: number }[] = [];
    for (const r of regs) {
      const { data: sample } = await supabase
        .from("sheet_rows")
        .select("canonical, extras")
        .eq("sheet_registry_id", r.id)
        .limit(5);
      const cols = new Set<string>();
      for (const row of sample ?? []) {
        Object.keys((row.canonical as Record<string, unknown>) ?? {}).forEach((k) => cols.add(k.toLowerCase()));
        Object.keys((row.extras as Record<string, unknown>) ?? {}).forEach((k) => cols.add(k.toLowerCase().replace(/\s+/g, "_")));
      }
      let score = 0;
      if (r.sheet_type === "material_reconciliation") score += 5;
      if ([...cols].some((c) => /planned/.test(c))) score += 2;
      if ([...cols].some((c) => /consumed|received/.test(c))) score += 2;
      if ([...cols].some((c) => /balance|variance/.test(c))) score += 1;
      scored.push({ id: r.id, label: r.display_name, matchScore: score });
    }
    scored.sort((a, b) => b.matchScore - a.matchScore);
    const best = scored[0];
    if (!best || best.matchScore < 2) {
      return { summary: null, sheetLabel: null, sheetId: null, consideredSheets: scored };
    }

    const { data: allRows, error: rowsErr } = await supabase
      .from("sheet_rows")
      .select("canonical, extras")
      .eq("sheet_registry_id", best.id)
      .order("row_index", { ascending: true })
      .limit(5000);
    if (rowsErr) throw new Error(rowsErr.message);

    const merged: Record<string, unknown>[] = [];
    for (const row of allRows ?? []) {
      const m: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((row.canonical as Record<string, unknown>) ?? {})) m[k] = v;
      for (const [k, v] of Object.entries((row.extras as Record<string, unknown>) ?? {})) {
        const key = k.toLowerCase().replace(/\s+/g, "_");
        if (!(key in m)) m[key] = v;
      }
      merged.push(m);
    }

    return {
      summary: computeReconciliation(merged),
      sheetLabel: best.label,
      sheetId: best.id,
      consideredSheets: scored,
    };
  });
