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

// ── Source-agnostic header resolution ───────────────────────────────────────
// Any new sheet/data source will use its own column names. Rather than
// hard-coding one alias list per sheet, we (1) try the known aliases, then
// (2) scan every header of the row and take the first whose NORMALIZED name
// matches a semantic pattern (e.g. anything containing "activity" / "task").
// This keeps links, row keys and detail pages working for sources we have
// never seen before.
function normHeader(k: string): string {
  return k.toLowerCase().replace(/[\s\-_/.,;:()\u2013\u2014]+/g, " ").trim();
}

/** First non-empty value whose header matches any of the given patterns. */
export function pickByPattern(r: Row, patterns: RegExp[]): string {
  for (const p of patterns) {
    for (const k of Object.keys(r)) {
      if (k.startsWith("__")) continue;
      if (!p.test(normHeader(k))) continue;
      const v = r[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    }
  }
  return "";
}

export function personName(r: Row) {
  // Prefer the resolved display name stamped onto decorated rows by the
  // AgentDashboard's person resolver. Falls back to the raw source columns,
  // then to any owner-like header on unknown sources.
  const decorated = pick(r, "__personDisplay");
  if (decorated) return decorated;
  return (
    pick(r, "Responsible Person", "Responsibility", "approvers name", "Owner Name", "Assignee") ||
    pickByPattern(r, [
      /responsib|approver|owner|assignee|assigned to|accountable|in charge|incharge|spoc|poc/,
      /\b(person|manager|engineer|officer|lead)\b/,
    ])
  );
}
export function personEmail(r: Row) {
  return (
    pick(r, "__personEmail", "Responsible Person Mail ID", "approvers email id") ||
    pickByPattern(r, [/mail/])
  );
}
export function stageName(r: Row) {
  return (
    pick(r, "Stages", "Stages of Process", "Stage", "Phase", "Milestone") ||
    pickByPattern(r, [/\bstage|phase|milestone|process stage\b/])
  );
}
export function activityName(r: Row) {
  return (
    pick(r, "Activity List", "Process Descriptions", "Process", "Activity", "Task", "Task Name",
      "Work Item", "Description", "Particulars", "Title") ||
    pickByPattern(r, [
      /activity|task|work item|particular|deliverable|scope item/,
      /\b(process|description|title|name|subject)\b/,
    ])
  );
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
    delay: s.delay,
  };
}

/** Summary stats used in metric strips. */
export function summarize(scoped: ScopedRow[]) {
  const n = scoped.length;
  let done = 0, delayed = 0, delayDaysSum = 0, tatSum = 0, takenSum = 0, tatCount = 0;
  for (const r of scoped) {
    const terminal = isRowEffectivelyDone(r.row);
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

const SR_NO_ALIASES = [
  "Sr. No.", "Sr No", "Sr.No", "Sr.No.", "Serial No", "Serial No.",
  "S. No.", "S No", "S.No", "S.No.", "SNo", "Sl. No.", "Sl No",
  "ID", "Id", "id",
];

export function rowIdent(r: Row, projectLabel?: string): RowIdent {
  return {
    project: projectLabel || String(r["__project"] ?? "") || "",
    // Unknown sources name their index column anything ("Sr no", "S/N",
    // "Item No", "Ref ID"); fall back to a header pattern scan so row keys
    // stay stable for sheets we've never seen.
    srNo: pick(r, ...SR_NO_ALIASES)
      || pickByPattern(r, [/^(sr|s|sl|srl|seq|item|line|ref)\b.*\b(no|num|number|id)\b/, /^(no|id)$/]),
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

/** Normalize identity strings so tiny drift (case, punctuation, whitespace,
 * leading zeros on Sr. No.) doesn't break row-key matching from dashboard
 * cards. Mirrors the fuzzy-normalize logic used by stage/person routes. */
const PLACEHOLDERS = new Set(["", "-", "--", "\u2014", "\u2013", "n a", "na", "none", "null", "undefined", "unnamed", "unassigned"]);

/** True when a label is a UI placeholder ("\u2014", "Unassigned", blank ...) and
 * therefore must never be turned into an entity link. */
export function isPlaceholderLabel(s: unknown): boolean {
  const t = String(s ?? "").toLowerCase().replace(/[\s\-_/.,;:()\u2013\u2014]+/g, " ").trim();
  return PLACEHOLDERS.has(t);
}

function normIdent(s: string): string {
  const t = String(s ?? "").toLowerCase().replace(/[\s\-_/.,;:()\u2013\u2014]+/g, " ").trim();
  // Detail pages render placeholder dashes ("\u2014") when a sheet column is blank.
  // Treat those as "unknown" instead of a literal value, otherwise a link built
  // from a placeholder can never match the real row.
  return PLACEHOLDERS.has(t) ? "" : t;
}
function normSrNo(s: string): string {
  const raw = String(s ?? "").trim();
  if (!raw) return "";
  const t = raw
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/^0+/, "")
    .replace(/[\s\-_/.,;:()]+/g, "");
  return t || "0";
}

function looseEqualOrContains(want: string, got: string): boolean {
  if (!want || !got) return false;
  return got === want || got.includes(want) || want.includes(got);
}

/** Match a source row against a decoded ident. Falls back to activity if Sr. No. is blank.
 * All comparisons are normalized (case/whitespace/punctuation-insensitive) so
 * dashboard card links resolve even when sheet values have minor drift.
 *
 * Important: a few sheets repeat Sr. No. values across sections. When the URL
 * carries both Sr. No. and activity, require BOTH to match; otherwise the row
 * page can hydrate the first row with that Sr. No. and show a different task
 * than the card the user clicked. */
export function rowMatchesIdent(r: Row, ident: RowIdent, projectLabel?: string): boolean {
  const id = rowIdent(r, projectLabel);
  const wantProject = normIdent(ident.project);
  const gotProject = normIdent(id.project);
  if (wantProject && gotProject && wantProject !== gotProject) {
    // allow contains-match either direction (e.g. "Himachal" vs "Himachal Pradesh")
    if (!gotProject.includes(wantProject) && !wantProject.includes(gotProject)) return false;
  }
  const wantSr = normSrNo(ident.srNo);
  const gotSr = normSrNo(id.srNo);
  const wantAct = normIdent(ident.activity);
  const gotAct = normIdent(id.activity);
  if (wantSr && gotSr) {
    if (wantSr !== gotSr) return false;
    if (wantAct && gotAct) return looseEqualOrContains(wantAct, gotAct);
    return true;
  }
  if (!wantAct) return false;
  return looseEqualOrContains(wantAct, gotAct);
}
