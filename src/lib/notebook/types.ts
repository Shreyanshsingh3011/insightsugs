export type SourceKind = "sheet" | "concerns" | "reminders";

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

export type ComputedResult = {
  formatted: string;
  explanation?: string;
  contributingRows: { sheet: string; row: number }[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  generated_by?: string | null;
  created_at?: string;
};
