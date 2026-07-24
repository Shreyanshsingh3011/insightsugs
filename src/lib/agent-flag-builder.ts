// Client-side flag builder that mirrors buildDashboardFromSheets's flag
// logic, but sources its rows from the same FALLBACK_PROJECTS payloads the
// dashboard renders (via useAgentSources). Keeps /alerts and /agent in
// perfect sync — no registry required.

import type { Row } from "@/lib/entity-scope";
import type { FlagEntry } from "@/lib/dashboard-data";
import {
  isRowEffectivelyDone,
  isTerminalRow,
  parseDateCell,
  rowStatusText,
  sanitizedDelayDays,
  statusBucketForRow,
} from "@/lib/status-utils";

const PLANNED_END_ALIASES = [
  "Planned End Date", "Planned End", "Planned Completion Date",
  "Planned Completion", "Due Date", "Target Date", "Expected Date",
  "Expected Completion Date", "ETA", "Deadline", "End Date",
  "Scheduled End", "Scheduled End Date",
];

function pick(row: Row, aliases: string[]): string {
  for (const key of aliases) {
    const v = row[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const wanted = new Set(aliases.map(norm));
  for (const [k, v] of Object.entries(row)) {
    if (!wanted.has(norm(k))) continue;
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function overdueDays(row: Row, isDone: boolean): number {
  const explicit = sanitizedDelayDays(row);
  if (explicit > 0) return explicit;
  if (isDone) return 0;
  const planned = parseDateCell(pick(row, PLANNED_END_ALIASES));
  if (!planned) return 0;
  return Math.max(0, daysBetween(planned, new Date()));
}

function severityFor(overdue: number): string {
  if (overdue >= 15) return "Critical";
  if (overdue >= 7) return "High";
  if (overdue >= 3) return "Medium";
  return "Low";
}

function ownerFor(row: Row): { person?: string; email?: string } {
  const person = String(
    row["__personDisplay"] ??
    row["Responsible Person"] ??
    row["Responsibility"] ??
    row["approvers name"] ??
    ""
  ).trim();
  const email = String(
    row["__personEmail"] ??
    row["Responsible Person Mail ID"] ??
    row["approvers email id"] ??
    ""
  ).trim().toLowerCase();
  return {
    person: person || undefined,
    email: email || undefined,
  };
}

function activityFor(row: Row): string | undefined {
  const v = String(
    row["Activity"] ?? row["Item"] ?? row["Material"] ?? row["KPI"] ??
    row["Bill No"] ?? row["PO No"] ?? row["Work Description"] ??
    row["Description"] ?? ""
  ).trim();
  return v || undefined;
}

function reasonFor(row: Row): string | undefined {
  const v = String(row["Remarks"] ?? row["Reason"] ?? row["Delay Reason"] ?? "").trim();
  return v || undefined;
}

function tatFor(row: Row): number | null {
  const n = Number(String(row["TAT"] ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
}

function daysTakenFor(row: Row): number | null {
  const n = Number(String(row["Days Taken"] ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 3650 ? n : null;
}

export function buildAgentFlags(rows: Row[]): FlagEntry[] {
  const flags: FlagEntry[] = [];
  let seq = 1;

  for (const row of rows) {
    // Skip completed / effectively-done rows — no alert needed.
    if (isTerminalRow(row) || isRowEffectivelyDone(row)) continue;

    const bucket = statusBucketForRow(row);
    const statusText = rowStatusText(row) || bucket;
    const isDelayed = bucket === "Delayed" || /delay|late|overdue|breach|slipp/i.test(statusText);
    const overdue = overdueDays(row, false);

    // Only surface rows that are genuinely delayed OR overdue by date math.
    if (!isDelayed && overdue <= 0) continue;

    // Suppress "not started" rows with zero signal (matches server logic).
    if (bucket === "Not Started" && overdue === 0) continue;

    const owner = ownerFor(row);
    const activity = activityFor(row);
    const dept = String(row["Department"] ?? row["Vertical"] ?? row["__department"] ?? "").trim() || undefined;

    const hasIdentity = !!(activity || owner.person || dept);
    if (!hasIdentity) continue;

    const source = String(row["__project"] ?? "").trim() || "sheet";

    flags.push({
      id: `L-${String(seq++).padStart(4, "0")}`,
      activity: activity ?? "(unnamed)",
      flagged_to: owner.person || owner.email ? owner : undefined,
      reason: reasonFor(row),
      reason_text: reasonFor(row),
      tat: tatFor(row),
      days_taken: daysTakenFor(row),
      overdue_days: overdue,
      severity: severityFor(overdue),
      status: isDelayed ? "Delayed" : bucket,
      stage: source,
      source,
      escalation_level: overdue >= 15 ? 2 : overdue >= 7 ? 1 : 0,
    });
  }

  flags.sort((a, b) => (b.overdue_days ?? 0) - (a.overdue_days ?? 0));
  return flags;
}
