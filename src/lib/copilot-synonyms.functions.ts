import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CopilotSynonym = {
  id: string;
  term: string;
  sheet_id: string | null;
  column_name: string | null;
  value: string | null;
  intent: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeTerm(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

const SELECT_COLS =
  "id, term, sheet_id, column_name, value, intent, note, created_at, updated_at";

export const listCopilotSynonyms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("copilot_synonyms")
      .select(SELECT_COLS)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as CopilotSynonym[];
  });

// Canonical intents that verb-phrase teachings can map to. Kept in sync with
// CanonicalIntent in copilot-verb-lexicon.ts.
const CANONICAL_INTENTS = [
  "distribution", "lookup", "list", "count", "aggregate", "filter",
  "compare", "trend", "top", "bottom", "temporal", "causal",
  "summarize", "predict",
] as const;

const SaveSchema = z.object({
  term: z.string().trim().min(1).max(200),
  sheet_id: z.string().uuid().nullable().optional(),
  column_name: z.string().trim().max(200).nullable().optional(),
  value: z.string().trim().max(500).nullable().optional(),
  intent: z.enum(CANONICAL_INTENTS).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const saveCopilotSynonym = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => SaveSchema.parse(input))
  .handler(async ({ data, context }) => {
    const term_normalized = normalizeTerm(data.term);
    if (!term_normalized) throw new Error("Term is required");
    if (!data.sheet_id && !data.column_name && !data.value && !data.intent) {
      throw new Error("Provide at least one of: sheet, column, value, or intent");
    }
    const row = {
      user_id: context.userId,
      term: data.term.trim(),
      term_normalized,
      sheet_id: data.sheet_id ?? null,
      column_name: data.column_name?.trim() || null,
      value: data.value?.trim() || null,
      intent: data.intent ?? null,
      note: data.note?.trim() || null,
    };
    const { data: upserted, error } = await context.supabase
      .from("copilot_synonyms")
      .upsert(row, { onConflict: "user_id,term_normalized" })
      .select(SELECT_COLS)
      .single();
    if (error) throw new Error(error.message);
    return upserted as CopilotSynonym;
  });

export const deleteCopilotSynonym = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("copilot_synonyms")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
