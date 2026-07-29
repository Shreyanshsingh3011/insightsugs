// Shared types for the standalone Notebook Copilot (public-link chat widget).
export type SourceKind = "sheet" | "concerns" | "reminders";

/** A source the user has toggled on/off in the notebook sidebar. */
export type EnabledSource = {
  type: SourceKind;
  label: string;
  row_count: number;
  columns?: string[];
};

export type Citation =
  | { type: "sheet"; sheet: string; row?: number }
  | { type: "concern"; id?: string }
  | { type: "reminder"; id?: string };

export type ContextItem = { tag: string; text: string };

/** Result of a deterministic aggregation, ready to render + cite. */
export type ComputedResult = {
  formatted: string;
  explanation?: string;
  contributingRows: { sheet: string; row: number }[];
};

/** One persisted notebook chat message. */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  generated_by?: string | null;
  created_at?: string;
};
