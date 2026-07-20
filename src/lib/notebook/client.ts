// Thin client for the copilot-notebook edge function + notebook tables.
import { supabase } from "@/integrations/supabase/client";
import type { Citation, ContextItem, ComputedResult, EnabledSource } from "./types";

export function tokenFromBase(base: string): string {
  const m = /\/api\/public\/([^/?#]+)/.exec(base);
  return m ? m[1] : base; // fallback: whole base
}

type ChatResponse = { text: string; citations: Citation[]; generated_by: string; offline?: boolean };

export async function callChat(opts: {
  token: string;
  question: string;
  computedResult?: ComputedResult;
  contextItems?: ContextItem[];
  history?: { role: "user" | "assistant"; content: string }[];
}): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    mode: "chat",
    token: opts.token,
    question: opts.question,
    history: opts.history ?? [],
  };
  if (opts.computedResult) {
    body.mode_hint = "quantitative";
    body.computed_result = { formatted: opts.computedResult.formatted, explanation: opts.computedResult.explanation };
    body.citations_seed = opts.computedResult.contributingRows.map((r) => ({ type: "sheet", sheet: r.sheet, row: r.row }));
  } else {
    body.mode_hint = "qualitative";
    body.context_items = opts.contextItems ?? [];
  }
  const { data, error } = await supabase.functions.invoke("copilot-notebook", { body });
  if (error) throw error;
  return data as ChatResponse;
}

export async function summarizeSource(opts: {
  token: string; type: string; label: string; sample: unknown; row_count: number;
}): Promise<{ summary: string; offline?: boolean }> {
  const { data, error } = await supabase.functions.invoke("copilot-notebook", {
    body: { mode: "summarize_source", ...opts },
  });
  if (error) throw error;
  return data as { summary: string };
}

export async function suggestQuestions(opts: { token: string; enabled_sources: EnabledSource[] }): Promise<{ suggestions: string[] }> {
  const { data, error } = await supabase.functions.invoke("copilot-notebook", {
    body: { mode: "suggest_questions", ...opts },
  });
  if (error) throw error;
  return data as { suggestions: string[] };
}

// All notebook access goes through SECURITY DEFINER RPCs. The tables have no
// direct anon/authenticated grants — RPCs validate the capability token
// (length >= 32, [A-Za-z0-9_-]) which blocks enumeration/brute-force.
export async function loadHistory(token: string) {
  const { data, error } = await supabase.rpc("notebook_load_messages", { _token: token });
  if (error) throw error;
  return data ?? [];
}

export async function loadSources(token: string) {
  const { data, error } = await supabase.rpc("notebook_load_sources", { _token: token });
  if (error) throw error;
  return data ?? [];
}

export async function upsertSource(token: string, row: { type: string; label: string; enabled?: boolean; row_count?: number }) {
  const { error } = await supabase.rpc("notebook_upsert_source", {
    _token: token,
    _type: row.type,
    _label: row.label,
    _enabled: row.enabled ?? true,
    _row_count: row.row_count ?? 0,
  });
  if (error) throw error;
}
