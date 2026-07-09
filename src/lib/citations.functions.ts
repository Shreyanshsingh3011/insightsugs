// Server function to resolve chatbot citation chips to the underlying
// source context (sheet row / document / dashboard field) shown in the
// side panel when a user clicks a chip.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type CitationContext =
  | {
      kind: "sheet";
      label: string;
      row: number;
      sheet?: { id: string; display_name: string; source_url: string | null; last_refreshed_at: string | null };
      canonical?: Record<string, Json>;
      extras?: Record<string, Json>;
      found: boolean;
    }
  | {
      kind: "doc";
      label: string;
      page: number;
      doc?: { id: string; name: string; page_count: number | null; summary: string | null };
      key_points?: Json;
      found: boolean;
    };

export const getCitationContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { kind: "sheet" | "doc"; label: string; row?: number; page?: number }) => ({
    kind: z.enum(["sheet", "doc"]).parse(raw.kind),
    label: z.string().min(1).max(200).parse(raw.label),
    row: raw.row === undefined ? undefined : z.number().int().min(0).parse(raw.row),
    page: raw.page === undefined ? undefined : z.number().int().min(0).parse(raw.page),
  }))
  .handler(async ({ data, context }): Promise<CitationContext> => {
    if (data.kind === "sheet") {
      const row = data.row ?? 0;
      const { data: reg } = await context.supabase
        .from("sheet_registry")
        .select("id, display_name, source_url, last_refreshed_at")
        .ilike("display_name", data.label.trim())
        .limit(1)
        .maybeSingle();
      if (!reg) return { kind: "sheet", label: data.label, row, found: false };
      const { data: r } = await context.supabase
        .from("sheet_rows")
        .select("canonical, extras")
        .eq("sheet_registry_id", reg.id)
        .eq("row_index", row)
        .maybeSingle();
      return {
        kind: "sheet",
        label: data.label,
        row,
        sheet: reg,
        canonical: (r?.canonical as Record<string, Json> | null) ?? undefined,
        extras: (r?.extras as Record<string, Json> | null) ?? undefined,
        found: !!r,
      };
    }
    // doc
    const page = data.page ?? 0;
    const { data: doc } = await context.supabase
      .from("documents")
      .select("id, name, page_count, summary, key_points")
      .ilike("name", data.label.trim())
      .limit(1)
      .maybeSingle();
    if (!doc) return { kind: "doc", label: data.label, page, found: false };
    return {
      kind: "doc",
      label: data.label,
      page,
      doc: { id: doc.id, name: doc.name, page_count: doc.page_count, summary: doc.summary },
      key_points: doc.key_points,
      found: true,
    };
  });
