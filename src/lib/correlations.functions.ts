// Correlation Engine — one entry point per focus entity kind. Hybrid matching:
// exact SQL joins first, embedding top-up only when the exact bucket is thin.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type MatchType = "exact" | "semantic";
export type CorrelationRef =
  | { kind: "activity"; id: string; projectId: string }
  | { kind: "sheet_row"; sheetRegistryId: string; rowIndex: number }
  | { kind: "project"; id: string }
  | { kind: "person"; id: string };

export type CorrelationItem = {
  ref: CorrelationRef;
  label: string;
  subtitle: string | null;
  matchType: MatchType;
  score: number | null; // 0..1 for semantic; null for exact
  why: string;
};

export type CorrelationBuckets = {
  crossSheet: CorrelationItem[];
  crossTask: CorrelationItem[];
  crossProject: CorrelationItem[];
  semantic: CorrelationItem[];
};

const KindEnum = z.enum(["activity", "sheet_row", "project", "person"]);

const MIN_PER_BUCKET = 5;

// ---------------------------------------------------------------------------
// Entity picker: typeahead across activities, projects, sheet rows, and people
// ---------------------------------------------------------------------------
export type PickerEntity = {
  kind: "activity" | "sheet_row" | "project" | "person";
  id: string;
  label: string;
  subtitle: string | null;
  meta?: { sheetRegistryId?: string; rowIndex?: number };
};

export const listCorrelationEntities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { query?: string; limit?: number } = {}) => ({
    query: (raw.query ?? "").trim().slice(0, 100),
    limit: Math.min(Math.max(raw.limit ?? 10, 1), 25),
  }))
  .handler(async ({ data, context }): Promise<PickerEntity[]> => {
    const { supabase } = context;
    const q = data.query;
    if (!q) return [];
    const like = `%${q}%`;

    const [acts, projs, people, sheets] = await Promise.all([
      supabase.from("activities").select("id, title, project_id, projects(name)")
        .ilike("title", like).limit(data.limit),
      supabase.from("projects").select("id, name, code").or(`name.ilike.${like},code.ilike.${like}`).limit(data.limit),
      supabase.from("profiles").select("id, full_name, email")
        .or(`full_name.ilike.${like},email.ilike.${like}`).limit(data.limit),
      supabase.from("sheet_rows").select("sheet_registry_id, row_index, canonical, sheet_registry(display_name)")
        .filter("canonical->>activity", "ilike", like).limit(data.limit),
    ]);

    const out: PickerEntity[] = [];
    for (const a of acts.data ?? []) {
      const pr = (a as unknown as { projects?: { name?: string } }).projects;
      out.push({ kind: "activity", id: a.id, label: a.title, subtitle: pr?.name ?? null });
    }
    for (const p of projs.data ?? []) {
      out.push({ kind: "project", id: p.id, label: p.name, subtitle: p.code });
    }
    for (const p of people.data ?? []) {
      out.push({ kind: "person", id: p.id, label: p.full_name || p.email || "(no name)", subtitle: p.email });
    }
    for (const r of sheets.data ?? []) {
      const sheet = (r as unknown as { sheet_registry?: { display_name?: string } }).sheet_registry;
      const canon = (r.canonical ?? {}) as Record<string, string>;
      out.push({
        kind: "sheet_row",
        id: `${r.sheet_registry_id}:${r.row_index}`,
        label: canon.activity || `Row ${r.row_index}`,
        subtitle: sheet?.display_name ?? null,
        meta: { sheetRegistryId: r.sheet_registry_id, rowIndex: r.row_index },
      });
    }
    return out;
  });

// ---------------------------------------------------------------------------
// Main correlation entry
// ---------------------------------------------------------------------------
export const getCorrelations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: { kind: string; id: string; rowIndex?: number }) => ({
    kind: KindEnum.parse(raw.kind),
    id: z.string().min(1).parse(raw.id),
    rowIndex: raw.rowIndex,
  }))
  .handler(async ({ data, context }): Promise<CorrelationBuckets> => {
    const { supabase, userId } = context;
    const buckets: CorrelationBuckets = {
      crossSheet: [], crossTask: [], crossProject: [], semantic: [],
    };

    // Resolve the focus entity into a "needle" for semantic/cross-sheet lookups
    let needle = "";
    let focusText = "";
    let focusAssigneeId: string | null = null;
    let focusProjectId: string | null = null;

    if (data.kind === "activity") {
      const { data: a } = await supabase
        .from("activities")
        .select("id, title, description, assignee_id, project_id")
        .eq("id", data.id).maybeSingle();
      if (a) {
        needle = a.title;
        focusText = [a.title, a.description].filter(Boolean).join(" — ");
        focusAssigneeId = a.assignee_id;
        focusProjectId = a.project_id;
      }
    } else if (data.kind === "sheet_row") {
      const { data: r } = await supabase.from("sheet_rows")
        .select("canonical, sheet_registry_id, row_index")
        .eq("sheet_registry_id", data.id)
        .eq("row_index", data.rowIndex ?? -1)
        .maybeSingle();
      const canon = ((r?.canonical ?? {}) as Record<string, string>);
      needle = canon.activity || canon.owner || "";
      focusText = Object.values(canon).filter(Boolean).join(" ");
    } else if (data.kind === "project") {
      const { data: p } = await supabase.from("projects")
        .select("name, code, description").eq("id", data.id).maybeSingle();
      needle = p?.name ?? "";
      focusText = [p?.name, p?.code, p?.description].filter(Boolean).join(" — ");
      focusProjectId = data.id;
    } else if (data.kind === "person") {
      const { data: p } = await supabase.from("profiles")
        .select("full_name, email").eq("id", data.id).maybeSingle();
      needle = p?.full_name ?? p?.email ?? "";
      focusText = needle;
    }

    // ---------- Cross-sheet (exact via canonical.activity / canonical.owner)
    if (needle) {
      const { data: rows } = await supabase.rpc("find_cross_sheet_rows", {
        _user_id: userId, _needle: needle, _limit: 30,
      });
      for (const r of (rows ?? []) as Array<{
        sheet_registry_id: string; sheet_name: string; row_index: number;
        activity: string | null; owner: string | null; status: string | null; matched_on: string;
      }>) {
        // Skip the focus row itself
        if (data.kind === "sheet_row" && r.sheet_registry_id === data.id && r.row_index === data.rowIndex) continue;
        buckets.crossSheet.push({
          ref: { kind: "sheet_row", sheetRegistryId: r.sheet_registry_id, rowIndex: r.row_index },
          label: r.activity || r.owner || `Row ${r.row_index}`,
          subtitle: `${r.sheet_name}${r.status ? ` · ${r.status}` : ""}`,
          matchType: "exact",
          score: null,
          why: `Matched on ${r.matched_on}: "${needle}"`,
        });
      }
    }

    // ---------- Cross-task dependencies (activity focus only)
    if (data.kind === "activity") {
      const { data: links } = await supabase.rpc("find_cross_task_links", {
        _user_id: userId, _activity_id: data.id, _limit: 25,
      });
      for (const l of (links ?? []) as Array<{
        id: string; project_id: string; project_name: string; title: string;
        status: string; assignee_id: string | null; assignee_name: string | null; relation: string;
      }>) {
        buckets.crossTask.push({
          ref: { kind: "activity", id: l.id, projectId: l.project_id },
          label: l.title,
          subtitle: `${l.project_name} · ${l.status}${l.assignee_name ? ` · ${l.assignee_name}` : ""}`,
          matchType: "exact",
          score: null,
          why: `${l.relation} of the focus task`,
        });
      }
    }

    // ---------- Cross-project shared entities
    if (data.kind === "person") {
      const { data: prj } = await supabase.rpc("find_person_footprint", {
        _user_id: userId, _person_id: data.id, _limit: 40,
      });
      for (const p of (prj ?? []) as Array<{
        project_id: string; project_name: string; activity_count: number;
        overdue_count: number; blocked_count: number;
      }>) {
        buckets.crossProject.push({
          ref: { kind: "project", id: p.project_id },
          label: p.project_name,
          subtitle: `${p.activity_count} task${p.activity_count === 1 ? "" : "s"}` +
            (p.overdue_count ? ` · ${p.overdue_count} overdue` : "") +
            (p.blocked_count ? ` · ${p.blocked_count} blocked` : ""),
          matchType: "exact",
          score: null,
          why: "Shared assignee",
        });
      }
    } else if (focusAssigneeId) {
      // For a focus activity: other projects the same assignee touches
      const { data: prj } = await supabase.rpc("find_person_footprint", {
        _user_id: userId, _person_id: focusAssigneeId, _limit: 20,
      });
      for (const p of (prj ?? []) as Array<{
        project_id: string; project_name: string; activity_count: number;
        overdue_count: number; blocked_count: number;
      }>) {
        if (p.project_id === focusProjectId) continue;
        buckets.crossProject.push({
          ref: { kind: "project", id: p.project_id },
          label: p.project_name,
          subtitle: `${p.activity_count} task${p.activity_count === 1 ? "" : "s"} for the same assignee`,
          matchType: "exact",
          score: null,
          why: "Same assignee appears in this project",
        });
      }
    }

    // ---------- Semantic top-up (sheet rows only for now — column dims match)
    const needsSemantic =
      buckets.crossSheet.length < MIN_PER_BUCKET ||
      buckets.crossTask.length < MIN_PER_BUCKET;

    if (needsSemantic && focusText.trim()) {
      try {
        const { embedQuery } = await import("./embeddings.server");
        const vec = await embedQuery(focusText.slice(0, 2000));
        const { data: sim } = await supabase.rpc("match_all_sheet_rows", {
          _user_id: userId,
          _query: vec as unknown as string, // pgvector accepts array; supabase-js types are loose
          _match_count: 12,
        });
        for (const s of (sim ?? []) as Array<{
          sheet_registry_id: string; sheet_name: string; row_index: number;
          snippet: string; similarity: number;
        }>) {
          // Dedupe against the exact matches already in crossSheet
          const alreadyExact = buckets.crossSheet.some(
            (b) => b.ref.kind === "sheet_row" &&
                   b.ref.sheetRegistryId === s.sheet_registry_id &&
                   b.ref.rowIndex === s.row_index,
          );
          if (alreadyExact) continue;
          if (data.kind === "sheet_row" && s.sheet_registry_id === data.id && s.row_index === data.rowIndex) continue;
          buckets.semantic.push({
            ref: { kind: "sheet_row", sheetRegistryId: s.sheet_registry_id, rowIndex: s.row_index },
            label: s.snippet.slice(0, 80) || `Row ${s.row_index}`,
            subtitle: s.sheet_name,
            matchType: "semantic",
            score: Math.round(s.similarity * 1000) / 1000,
            why: `Semantic similarity ${(s.similarity * 100).toFixed(1)}%`,
          });
        }
      } catch (e) {
        // Semantic is best-effort; never break the whole response
        console.error("[correlations] semantic top-up failed:", e);
      }
    }

    return buckets;
  });
