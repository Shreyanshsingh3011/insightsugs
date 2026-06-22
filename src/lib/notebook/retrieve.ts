// Build a rich, structured context for qualitative answers.
// We send: (1) per-sheet schema, (2) precomputed facts, (3) row data within a char budget,
// (4) all concerns & reminders. Each item carries a tag so claims can be cited.
import type { ContextItem } from "./types";
import type { SheetSource, ColumnStats } from "./compute";
import { isTotalRow, inferColumnStats, fmtNumber } from "./compute";

const STOPWORDS = new Set("the a an of for and or to is are was were be been being in on at by with from this that these those it its as which what who whom how why when where do does did can could should would will may might".split(/\s+/));

const DEFAULT_BUDGET = 60000;

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

function fmtFacts(label: string, stats: ColumnStats[]): string {
  const lines: string[] = [`FACTS for "${label}":`];
  for (const s of stats) {
    if (s.type === "number") {
      lines.push(`  • ${s.column} [number] n=${s.nonEmpty}, sum=${fmtNumber(s.sum ?? 0)}, avg=${fmtNumber(s.avg ?? 0)}, min=${fmtNumber(s.min ?? 0)}, max=${fmtNumber(s.max ?? 0)}`);
    } else if (s.type === "categorical" && s.topValues) {
      const items = s.topValues.map((v) => `${v.value}=${v.count}`).join(", ");
      lines.push(`  • ${s.column} [categorical] distinct=${s.distinct}: ${items}`);
    } else if (s.type === "date") {
      lines.push(`  • ${s.column} [date] n=${s.nonEmpty}`);
    } else {
      lines.push(`  • ${s.column} [text] n=${s.nonEmpty}${s.distinct ? `, distinct=${s.distinct}` : ""}`);
    }
  }
  return lines.join("\n");
}

function rowText(sheet: SheetSource, rec: Record<string, unknown>): string {
  return sheet.columns
    .slice(0, 12)
    .map((c) => `${c}=${String(rec[c] ?? "").slice(0, 120)}`)
    .join("; ");
}

export function buildContext(opts: {
  question: string;
  sheets: SheetSource[];
  concerns: ConcernLite[];
  reminders: ReminderLite[];
  budgetChars?: number;
}): ContextItem[] {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET;
  const tokens = tokenize(opts.question);
  const out: ContextItem[] = [];
  let used = 0;
  const push = (item: ContextItem) => {
    const size = item.tag.length + item.text.length + 2;
    if (used + size > budget) return false;
    out.push(item);
    used += size;
    return true;
  };

  // 1) Schema per sheet
  for (const s of opts.sheets) {
    push({
      tag: `[[Schema:${s.label}]]`,
      text: `SHEET "${s.label}" — ${s.rows.length} rows. Columns: ${s.columns.join(", ")}.`,
    });
  }

  // 2) Precomputed facts per sheet
  const statsBySheet = new Map<string, ColumnStats[]>();
  for (const s of opts.sheets) {
    const stats = inferColumnStats(s);
    statsBySheet.set(s.label, stats);
    push({ tag: `[[Facts:${s.label}]]`, text: fmtFacts(s.label, stats) });
  }

  // 3) Concerns & Reminders (small, always included first within budget)
  for (let i = 0; i < opts.concerns.length; i++) {
    const c = opts.concerns[i];
    push({
      tag: `[[Concern:${c.id ?? `idx${i}`}]]`,
      text: `title=${c.title ?? ""}; status=${c.status ?? ""}; severity=${c.severity ?? ""}; target_department=${c.target_department ?? ""}; sheet=${c.sheet_label ?? ""}; detail=${(c.detail ?? "").slice(0, 240)}`,
    });
  }
  for (let i = 0; i < opts.reminders.length; i++) {
    const r = opts.reminders[i];
    push({
      tag: `[[Reminder:${r.id ?? `idx${i}`}]]`,
      text: `subject=${r.subject ?? ""}; status=${r.status ?? ""}; recipient=${r.recipient_email ?? ""}; schedule_at=${r.schedule_at ?? ""}; recurrence=${r.recurrence ?? ""}; body=${(r.body ?? "").slice(0, 200)}`,
    });
  }

  // 4) Sheet rows — score by token overlap, then add top-scored + uniform sample
  type Scored = { sheetLabel: string; row: number; text: string; score: number };
  const scoredBySheet = new Map<string, Scored[]>();
  for (const s of opts.sheets) {
    const arr: Scored[] = [];
    s.rows.forEach((rec, idx) => {
      if (isTotalRow(rec, s.columns)) return;
      const joined = Object.values(rec).map((v) => String(v ?? "")).join(" ").toLowerCase();
      let score = 0;
      for (const t of tokens) if (joined.includes(t)) score += 1;
      arr.push({ sheetLabel: s.label, row: idx, text: rowText(s, rec), score: score * 1000 - idx });
    });
    scoredBySheet.set(s.label, arr);
  }

  // Round-robin across sheets: top-scored first, then a uniform sample.
  const queues = [...scoredBySheet.entries()].map(([label, arr]) => {
    const sorted = [...arr].sort((a, b) => b.score - a.score);
    return { label, sorted, sentIndexes: new Set<number>(), totalRows: arr.length };
  });

  let added = true;
  while (added) {
    added = false;
    for (const q of queues) {
      const next = q.sorted.find((r) => !q.sentIndexes.has(r.row));
      if (!next) continue;
      const ok = push({ tag: `[[Sheet:${q.label}|row:${next.row}]]`, text: next.text });
      if (!ok) { added = false; break; }
      q.sentIndexes.add(next.row);
      added = true;
    }
  }

  // Footer note if any sheet got truncated
  for (const q of queues) {
    if (q.sentIndexes.size < q.totalRows) {
      push({
        tag: `[[Note:${q.label}]]`,
        text: `Showing ${q.sentIndexes.size} of ${q.totalRows} rows from "${q.label}" — use the Precomputed Facts above for totals/distributions.`,
      });
    }
  }

  return out;
}
