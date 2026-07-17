// Runtime row-quality validator for LIVE source rows (post-ingest).
//
// Distinct from `ingest-validation.ts` which validates the paste/CSV preview
// before commit. This one runs against the already-fetched dashboard rows
// and surfaces the two data-hygiene defects we keep tripping on:
//
//   1. Excel/Google Sheets DATE SERIALS leaking into duration columns
//      (TAT, Days Taken, Delay in Days) — e.g. 46028 / 46029. When a sheet
//      formula returns a date but the column is formatted as number, the
//      raw payload gives us a 30k-70k integer that torpedoes every metric.
//
//   2. Missing TAT / Days Taken on rows that are still ACTIVE. Without both
//      values we cannot compute pace, overdue days, or "timely completed".
//
// The output is consumed by RowQualityBadge (inline, per row) and
// RowQualitySummary (aggregate chip shown next to the dashboard metrics).

import { computeRowStatus, isTerminalRow } from "@/lib/status-utils";

export type RowQualityIssueKind =
  | "date_serial_in_tat"
  | "date_serial_in_days_taken"
  | "date_serial_in_delay"
  | "missing_tat"
  | "missing_days_taken"
  | "negative_duration";

export type RowQualityIssue = {
  rowIndex: number;
  column: string;
  kind: RowQualityIssueKind;
  rawValue: string;
  message: string;
};

export type RowQualityReport = {
  totalRows: number;
  rowsWithIssues: number;
  issuesByRow: Map<number, RowQualityIssue[]>;
  issues: RowQualityIssue[];
  counts: Record<RowQualityIssueKind, number>;
};

export const ROW_QUALITY_LABEL: Record<RowQualityIssueKind, string> = {
  date_serial_in_tat: "Date leaked into TAT",
  date_serial_in_days_taken: "Date leaked into Days Taken",
  date_serial_in_delay: "Date leaked into Delay",
  missing_tat: "Missing TAT",
  missing_days_taken: "Missing Days Taken",
  negative_duration: "Negative duration",
};

// Aliases mirror status-utils so we accept every project's column casing.
const TAT_ALIASES = ["TAT", "Tat", "tat", "TAT (days)", "TAT Days", "tat_days"];
const DAYS_TAKEN_ALIASES = ["Days Taken", "days_taken", "Days taken", "Days_Taken"];
const DELAY_ALIASES = [
  "Delay in Days", "delay_in_days", "Delay Days", "Delay (Days)", "Delay", "delay",
];

function pickValue(row: Record<string, unknown>, aliases: string[]): { key: string; raw: unknown } | null {
  for (const a of aliases) {
    if (a in row) {
      const v = row[a];
      if (v !== undefined && v !== null && String(v).trim() !== "") return { key: a, raw: v };
    }
  }
  return null;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

// Excel/Sheets date serials for plausible modern dates fall in this window.
// 30000 ≈ 1982-03-19, 70000 ≈ 2091-08-30 — anything inside that range
// showing up in a "days" column is virtually always a leaked date.
export function isDateSerialLike(n: number): boolean {
  return Number.isFinite(n) && n >= 30000 && n <= 70000;
}

function makeEmptyCounts(): Record<RowQualityIssueKind, number> {
  return {
    date_serial_in_tat: 0,
    date_serial_in_days_taken: 0,
    date_serial_in_delay: 0,
    missing_tat: 0,
    missing_days_taken: 0,
    negative_duration: 0,
  };
}

export function validateRowQuality(row: Record<string, unknown>, rowIndex: number): RowQualityIssue[] {
  const out: RowQualityIssue[] = [];

  const tat = pickValue(row, TAT_ALIASES);
  const taken = pickValue(row, DAYS_TAKEN_ALIASES);
  const delay = pickValue(row, DELAY_ALIASES);

  const checkSerial = (
    got: { key: string; raw: unknown } | null,
    kind: Extract<RowQualityIssueKind, `date_serial_in_${string}`>,
    label: string,
  ) => {
    if (!got) return;
    const n = toNum(got.raw);
    if (isDateSerialLike(n)) {
      out.push({
        rowIndex,
        column: got.key,
        kind,
        rawValue: String(got.raw),
        message: `${label} = ${n} looks like a date serial, not a day count`,
      });
    } else if (Number.isFinite(n) && n < 0) {
      out.push({
        rowIndex,
        column: got.key,
        kind: "negative_duration",
        rawValue: String(got.raw),
        message: `${label} = ${n} is negative`,
      });
    }
  };

  checkSerial(tat, "date_serial_in_tat", "TAT");
  checkSerial(taken, "date_serial_in_days_taken", "Days Taken");
  checkSerial(delay, "date_serial_in_delay", "Delay");

  // Missing TAT / Days Taken — only flag on ACTIVE rows. Terminal rows may
  // legitimately have blank duration columns when the sheet only tracks
  // completion via a date column.
  if (!isTerminalRow(row)) {
    if (!tat) {
      out.push({
        rowIndex,
        column: "TAT",
        kind: "missing_tat",
        rawValue: "",
        message: "TAT is missing — pace and overdue days cannot be computed",
      });
    }
    if (!taken) {
      out.push({
        rowIndex,
        column: "Days Taken",
        kind: "missing_days_taken",
        rawValue: "",
        message: "Days Taken is missing — completion progress cannot be computed",
      });
    }
  }

  // Cross-check: if computeRowStatus had to clamp to zero AND the raw column
  // held a serial, we already emitted date_serial_in_*; nothing extra to do.
  // The call keeps the helper in the dependency graph so future callers using
  // `computed.delay` upstream get a stable view — no side effects here.
  void computeRowStatus(row);

  return out;
}

export function buildRowQualityReport(rows: Array<Record<string, unknown>>): RowQualityReport {
  const issuesByRow = new Map<number, RowQualityIssue[]>();
  const issues: RowQualityIssue[] = [];
  const counts = makeEmptyCounts();

  for (let i = 0; i < rows.length; i++) {
    const rowIssues = validateRowQuality(rows[i], i);
    if (rowIssues.length === 0) continue;
    issuesByRow.set(i, rowIssues);
    for (const issue of rowIssues) {
      issues.push(issue);
      counts[issue.kind]++;
    }
  }

  return {
    totalRows: rows.length,
    rowsWithIssues: issuesByRow.size,
    issuesByRow,
    issues,
    counts,
  };
}

// ── Auto-fix suggestions ────────────────────────────────────────────────────
// Given a row's issues, propose concrete remediations the user can apply
// (either manually in the source sheet or via a future one-click patch).
//
//   "clear"     — wipe the offending cell; downstream metrics will recompute
//                 from the remaining signals (dates, status text, etc.).
//   "recompute" — derive the value from other columns already on the row
//                 (e.g. Days Taken = Completion Date − Start Date).
//   "set"       — write a specific literal value.
//   "leave"     — safe to leave blank on this row (usually terminal rows).

export type RowFixAction = "clear" | "recompute" | "set" | "leave";

export type RowFixSuggestion = {
  column: string;
  action: RowFixAction;
  value?: string;
  rationale: string;
  formula?: string;
};

const START_ALIASES = ["Start Date", "start_date", "Actual Start", "Planned Start"];
const COMPLETION_ALIASES_LOCAL = [
  "Completion Date", "Completed Date", "Actual Completion Date",
  "Actual End", "Finish Date", "completion_date", "actual_end", "finish_date",
];

function firstPresentKey(row: Record<string, unknown>, aliases: string[]): string | null {
  for (const a of aliases) {
    const v = row[a];
    if (v !== undefined && v !== null && String(v).trim() !== "") return a;
  }
  return null;
}

export function suggestAutoFixes(
  row: Record<string, unknown>,
  issues: RowQualityIssue[],
): RowFixSuggestion[] {
  const out: RowFixSuggestion[] = [];
  const startKey = firstPresentKey(row, START_ALIASES);
  const doneKey = firstPresentKey(row, COMPLETION_ALIASES_LOCAL);
  const terminal = isTerminalRow(row);

  for (const issue of issues) {
    switch (issue.kind) {
      case "date_serial_in_tat":
        out.push({
          column: issue.column,
          action: "clear",
          rationale:
            `"${issue.rawValue}" is a date serial, not a duration. Clear the cell and re-enter the TAT as a plain integer (days). The sheet cell is likely formatted as Date — switch it to Number.`,
        });
        break;
      case "date_serial_in_days_taken":
        if (startKey && doneKey) {
          out.push({
            column: issue.column,
            action: "recompute",
            formula: `= ${doneKey} − ${startKey}`,
            rationale:
              `Days Taken can be recomputed from the dates already on this row (${startKey} → ${doneKey}). The current value "${issue.rawValue}" is a date serial leaking in.`,
          });
        } else {
          out.push({
            column: issue.column,
            action: "clear",
            rationale:
              `"${issue.rawValue}" is a date serial. Clear the cell — downstream metrics will fall back to the status text and completion columns.`,
          });
        }
        break;
      case "date_serial_in_delay":
        out.push({
          column: issue.column,
          action: terminal ? "set" : "clear",
          value: terminal ? "0" : undefined,
          rationale: terminal
            ? `Row is already completed — Delay should be 0, not "${issue.rawValue}".`
            : `"${issue.rawValue}" is a date serial. Clear the cell so Delay recomputes from TAT vs Days Taken.`,
        });
        break;
      case "negative_duration":
        out.push({
          column: issue.column,
          action: "set",
          value: "0",
          rationale: `Negative durations don't make sense — replace "${issue.rawValue}" with 0 or the true value.`,
        });
        break;
      case "missing_tat":
        if (terminal) {
          out.push({
            column: issue.column,
            action: "leave",
            rationale:
              `Row is terminal — TAT is only needed for active rows, safe to leave blank.`,
          });
        } else {
          out.push({
            column: issue.column,
            action: "set",
            rationale:
              `Add the target TAT (in days) for this activity so pace and overdue calculations can run. Copy the TAT used for similar activities in this stage.`,
          });
        }
        break;
      case "missing_days_taken":
        if (terminal) {
          out.push({
            column: issue.column,
            action: "leave",
            rationale:
              `Row is terminal — Days Taken will be inferred from the completion date column.`,
          });
        } else if (startKey) {
          out.push({
            column: issue.column,
            action: "recompute",
            formula: `= TODAY() − ${startKey}`,
            rationale:
              `Days Taken can be derived from ${startKey} to today for an active row. Add a formula, or leave blank and the dashboard will fall back to status text.`,
          });
        } else {
          out.push({
            column: issue.column,
            action: "set",
            rationale: `Enter Days Taken manually, or fill in Start Date so it can be computed.`,
          });
        }
        break;
    }
  }
  return out;
}

export const ROW_FIX_ACTION_LABEL: Record<RowFixAction, string> = {
  clear: "Clear cell",
  recompute: "Recompute from other columns",
  set: "Set value",
  leave: "Safe to leave blank",
};

