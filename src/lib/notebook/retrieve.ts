// Build a compact set of context items for qualitative LLM answers.
import type { ContextItem } from "./types";
import type { SheetSource } from "./compute";
import { isTotalRow } from "./compute";

const STOPWORDS = new Set("the a an of for and or to is are was were be been being in on at by with from this that these those it its as which what who whom how why when where do does did can could should would will may might".split(/\s+/));

export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export type ConcernLite = {
  id?: string; title?: string; detail?: string; status?: string;
  severity?: string; target_department?: string; sheet_label?: string;
};
export type ReminderLite = {
  id?: string; subject?: string; body?: string; status?: string;
  recipient_email?: string; schedule_at?: string; recurrence?: string;
};

export function buildContext(opts: {
  question: string;
  sheets: SheetSource[]; // already filtered to enabled
  concerns: ConcernLite[]; // [] if disabled
  reminders: ReminderLite[]; // [] if disabled
  cap?: number;
}): ContextItem[] {
  const cap = opts.cap ?? 40;
  const tokens = tokenize(opts.question);
  const items: { score: number; item: ContextItem }[] = [];

  // Sheet rows — scored
  for (const s of opts.sheets) {
    s.rows.forEach((rec, idx) => {
      if (isTotalRow(rec, s.columns)) return;
      const joined = `${s.columns.join(" ")} ${Object.values(rec).map(String).join(" ")}`.toLowerCase();
      let score = 0;
      for (const t of tokens) if (joined.includes(t)) score += 1;
      if (score === 0 && tokens.length > 0) return;
      const parts = s.columns.slice(0, 8).map((c) => `${c}=${String(rec[c] ?? "").slice(0, 80)}`);
      items.push({
        score,
        item: { tag: `[[Sheet:${s.label}|row:${idx}]]`, text: parts.join("; ") },
      });
    });
  }

  // Concerns — always include all (few)
  const concernItems: ContextItem[] = opts.concerns.map((c, i) => ({
    tag: `[[Concern:${c.id ?? `idx${i}`}]]`,
    text: `title=${c.title ?? ""}; status=${c.status ?? ""}; severity=${c.severity ?? ""}; target_department=${c.target_department ?? ""}; sheet=${c.sheet_label ?? ""}; detail=${(c.detail ?? "").slice(0, 200)}`,
  }));

  // Reminders — always include all
  const reminderItems: ContextItem[] = opts.reminders.map((r, i) => ({
    tag: `[[Reminder:${r.id ?? `idx${i}`}]]`,
    text: `subject=${r.subject ?? ""}; status=${r.status ?? ""}; recipient=${r.recipient_email ?? ""}; schedule_at=${r.schedule_at ?? ""}; recurrence=${r.recurrence ?? ""}; body=${(r.body ?? "").slice(0, 160)}`,
  }));

  items.sort((a, b) => b.score - a.score);
  const sheetSlice = items.slice(0, Math.max(0, cap - concernItems.length - reminderItems.length)).map((x) => x.item);
  return [...sheetSlice, ...concernItems, ...reminderItems];
}
