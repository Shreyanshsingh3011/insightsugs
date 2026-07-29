// Shared types for the standalone Notebook Copilot (public-link chat widget).
export type SourceKind = "sheet" | "concerns" | "reminders";

/** A source the user has toggled on/off in the notebook sidebar. */
export type EnabledSource = {
  type: SourceKind;
  label: string;
  row_count: number;
  columns?: string[];
};

/**
 * A grounding reference attached to an assistant message, used both to render
 * clickable citation chips and to verify (see lib/notebook/verify.ts) that the
 * answer actually points at real data before it's shown as trustworthy.
 * - "sheet": `row` is a 0-based index into that sheet's rows array (optional —
 *   omitted when the claim is sheet-level rather than row-level).
 * - "concern"/"reminder": `id` links back to the source record for jump-to-open.
 */
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
