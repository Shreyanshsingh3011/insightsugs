// Shared row-scoping helpers used by the entity detail pages
// (person/stage/project). Reuses the same field aliases as AgentDashboard.

import { computeRowStatus, isRowEffectivelyDone, rowStatusText } from "@/lib/status-utils";

export type Row = Record<string, unknown>;


export function pick(r: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return "";
}
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function personName(r: Row) {
  // Prefer the resolved display name stamped onto decorated rows by the
  // AgentDashboard's person resolver. Falls back to the raw source columns.
  const decorated = pick(r, "__personDisplay");
  if (decorated) return decorated;
  return pick(r, "Responsible Person", "Responsibility", "approvers name", "Owner Name", "Assignee");
}
export function personEmail(r: Row) {
  return pick(r, "__personEmail", "Responsible Person Mail ID", "approvers email id");
}
export function stageName(r: Row) {
  return pick(r, "Stages", "Stages of Process");
}
export function activityName(r: Row) {
  return pick(r, "Activity List", "Process Descriptions", "Process");
}
export function statusText(r: Row) {
  return rowStatusText(r);
}

export type ScopedRow = {
  i: number;
  row: Row;
  project: string;
  activity: string;
  person: string;
  email: string;
  stage: string;
  status: string;
  tat: number;
  taken: number;
  delay: number;
};

export function toScopedRow(row: Row, i: number, projectLabel?: string): ScopedRow {
  // Route status/TAT/Days Taken/Delay through the canonical computeRowStatus
  // so entity pages match Agent Dashboard exactly — sanitizes Excel date-serial
  // leaks (46028/46029 in Delay/Days Taken columns) and honors terminal signals
  // when the sheet's Status text is stale (e.g. still "In Progress" after
  // completion dates were filled in).
  const s = computeRowStatus(row);
  return {
    i,
    row,
    project: projectLabel || String(row["__project"] ?? "") || "—",
    activity: activityName(row) || "(unnamed)",
    person: personName(row) || "Unassigned",
    email: personEmail(row),
    stage: stageName(row) || "—",
    status: s.label || statusText(row) || "—",
    tat: s.tat,
    taken: s.taken,
    delay: s.isDone ? 0 : s.delay,
  };
}

/** Summary stats used in metric strips. */
export function summarize(scoped: ScopedRow[]) {
  const n = scoped.length;
  let done = 0, delayed = 0, delayDaysSum = 0, tatSum = 0, takenSum = 0, tatCount = 0;
  for (const r of scoped) {
    const terminal = isTerminalRow(r.row);
    if (terminal) done++;
    if (r.delay > 0 && !terminal) { delayed++; delayDaysSum += r.delay; }
    if (r.tat > 0) { tatSum += r.tat; takenSum += r.taken; tatCount++; }
  }
  const completionPct = n ? Math.round((done / n) * 100) : 0;
  const onTimePct = n ? Math.max(0, 100 - Math.round((delayed / n) * 100)) : 100;
  const pacePct = tatCount ? Math.round((takenSum / Math.max(1, tatSum)) * 100) : 100;
  const avgDelay = delayed ? Math.round(delayDaysSum / delayed) : 0;
  const healthScore = Math.max(0, Math.min(100, Math.round(
    0.4 * onTimePct + 0.4 * completionPct + 0.2 * Math.max(0, 200 - pacePct) / 2
  )));
  return { n, done, delayed, delayDaysSum, avgDelay, completionPct, onTimePct, pacePct, healthScore };
}

/** URL-safe base64 for the person key in /agent/person/$key */
export function encodeKey(s: string): string {
  const b = typeof window === "undefined"
    ? Buffer.from(s, "utf8").toString("base64")
    : btoa(unescape(encodeURIComponent(s)));
  return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeKey(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof window === "undefined") return Buffer.from(b, "base64").toString("utf8");
  return decodeURIComponent(escape(atob(b)));
}

// ── Row identity ────────────────────────────────────────────────────────────
// Compact, deterministic URL key for a single source row. We only encode the
// identifier tuple (project + Sr. No. + activity) — never the full row — so
// the URL stays short and the page rehydrates from the live source cache.
export type RowIdent = { project: string; srNo: string; activity: string };

export function rowIdent(r: Row, projectLabel?: string): RowIdent {
  return {
    project: projectLabel || String(r["__project"] ?? "") || "",
    srNo: pick(r, "Sr. No.", "Sr No", "ID", "Id", "S.No", "SNo"),
    activity: activityName(r),
  };
}

export function encodeRowKey(ident: RowIdent): string {
  return encodeKey(`${ident.project}::${ident.srNo}::${ident.activity}`);
}

export function decodeRowKey(key: string): RowIdent {
  const raw = decodeKey(key);
  const [project = "", srNo = "", ...rest] = raw.split("::");
  return { project, srNo, activity: rest.join("::") };
}

/** Match a source row against a decoded ident. Falls back to activity if Sr. No. is blank. */
export function rowMatchesIdent(r: Row, ident: RowIdent, projectLabel?: string): boolean {
  const id = rowIdent(r, projectLabel);
  if (ident.project && id.project && id.project !== ident.project) return false;
  if (ident.srNo && id.srNo) return id.srNo === ident.srNo;
  return !!ident.activity && id.activity === ident.activity;
}
