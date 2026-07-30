import { encodeRowKey, isPlaceholderLabel, rowIdent, toScopedRow, type Row, type ScopedRow } from "@/lib/entity-scope";
import { isRowEffectivelyDone, statusBucketForRow } from "@/lib/status-utils";

const SNAPSHOT_KEY = "agent:dashboard-snapshot:v1";

export type DashboardVerificationTarget =
  | { kind: "row"; key: string }
  | { kind: "person"; label: string }
  | { kind: "stage"; label: string }
  | { kind: "project"; label: string }
  | { kind: "kpi"; id: "health" | "completed" | "ontime" | "delayed" | "overdue" | "tat" | "risk" | "remaining" | "notstarted" };

export type DashboardRowSnapshot = {
  key: string;
  project: string;
  activity: string;
  person: string;
  email: string;
  stage: string;
  status: string;
  bucket: string;
  terminal: boolean;
  tat: number;
  taken: number;
  delay: number;
  criticality: string;
};

export type DashboardSnapshot = {
  version: 1;
  savedAt: string;
  scopeLabel: string;
  selected: string;
  focusPerson: string;
  focusDept: string;
  generatedAt?: string;
  rowCount: number;
  signature: string;
  rows: DashboardRowSnapshot[];
};

/** A single field that disagrees between the dashboard snapshot and the destination page. */
export type ConsistencyFieldDiff = {
  key: string;
  label: string;
  field: string;
  expected: string;
  actual: string;
};

/** A recorded verification outcome, persisted so the mismatch inspector can review it. */
export type ConsistencyReport = {
  id: string;
  target: DashboardVerificationTarget;
  targetLabel: string;
  path: string;
  checkedAt: string;
  ok: boolean;
  available: boolean;
  expectedCount: number;
  actualCount: number;
  missingKeys: string[];
  extraKeys: string[];
  fieldDiffs: ConsistencyFieldDiff[];
  canonicalRows: DashboardRowSnapshot[];
  actualRows: DashboardRowSnapshot[];
  signature?: string;
  message: string;
};

export type DashboardConsistencyResult = {
  available: boolean;
  ok: boolean;
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  extraCount: number;
  signature?: string;
  scopeLabel?: string;
  savedAt?: string;
  message: string;
  samples: string[];
  targetLabel: string;
  missingKeys: string[];
  extraKeys: string[];
  fieldDiffs: ConsistencyFieldDiff[];
  canonicalRows: DashboardRowSnapshot[];
  actualRows: DashboardRowSnapshot[];
};

function norm(s: unknown): string {
  const t = String(s ?? "")
    .toLowerCase()
    .replace(/[\s\-_/.,;:()\u2013\u2014]+/g, " ")
    .trim();
  return isPlaceholderLabel(t) ? "" : t;
}

function rowKeyForScoped(row: ScopedRow): string {
  return encodeRowKey(rowIdent(row.row, row.project));
}

function countKeys(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function subtractCounts(want: Map<string, number>, got: Map<string, number>): string[] {
  const missing: string[] = [];
  for (const [key, n] of want.entries()) {
    const diff = n - (got.get(key) ?? 0);
    for (let i = 0; i < diff; i++) missing.push(key);
  }
  return missing;
}

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function signatureFor(rows: DashboardRowSnapshot[]): string {
  return hashString(
    rows
      .map((r) => `${r.key}|${r.bucket}|${r.terminal ? 1 : 0}|${r.tat}|${r.taken}|${r.delay}`)
      .sort()
      .join("\n"),
  );
}

export function buildDashboardSnapshot(rows: Row[], ctx: {
  scopeLabel: string;
  selected: string;
  focusPerson: string;
  focusDept: string;
  generatedAt?: string;
}): DashboardSnapshot {
  const snapshotRows = rows.map((raw, i): DashboardRowSnapshot => {
    const scoped = toScopedRow(raw, i, String(raw["__project"] ?? ctx.scopeLabel ?? ""));
    return {
      key: rowKeyForScoped(scoped),
      project: scoped.project,
      activity: scoped.activity,
      person: scoped.person,
      email: scoped.email,
      stage: scoped.stage,
      status: scoped.status,
      bucket: statusBucketForRow(raw),
      terminal: isRowEffectivelyDone(raw),
      tat: scoped.tat,
      taken: scoped.taken,
      delay: scoped.delay,
      criticality: String(raw["Criticality"] ?? ""),
    };
  });
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    scopeLabel: ctx.scopeLabel,
    selected: ctx.selected,
    focusPerson: ctx.focusPerson,
    focusDept: ctx.focusDept,
    generatedAt: ctx.generatedAt,
    rowCount: snapshotRows.length,
    signature: signatureFor(snapshotRows),
    rows: snapshotRows,
  };
}

export function saveDashboardSnapshot(snapshot: DashboardSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Session storage can be unavailable in restricted browsers. In that case
    // pages still render from live data; they just cannot show the parity badge.
  }
}

export function readDashboardSnapshot(): DashboardSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DashboardSnapshot>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rows)) return null;
    return parsed as DashboardSnapshot;
  } catch {
    return null;
  }
}

export function expectedRowsForTarget(snapshot: DashboardSnapshot, target: DashboardVerificationTarget): DashboardRowSnapshot[] {
  if (target.kind === "row") return snapshot.rows.filter((r) => r.key === target.key);
  if (target.kind === "project") {
    const want = norm(target.label);
    return snapshot.rows.filter((r) => norm(r.project) === want || norm(r.project).includes(want) || want.includes(norm(r.project)));
  }
  if (target.kind === "person") {
    const want = norm(target.label);
    if (!want) return snapshot.rows.filter((r) => isPlaceholderLabel(r.person));
    // Mirror the person page exactly: exact name/email matches win outright, and
    // only when there are none do we fall back to fuzzy containment. Without the
    // exact-first rule a combined owner cell ("A / B") over-matches every row
    // owned by either person and the parity check reports phantom mismatches.
    const exact = snapshot.rows.filter((r) => norm(r.person) === want || norm(r.email) === want);
    if (exact.length) return exact;
    return snapshot.rows.filter((r) => {
      const name = norm(r.person);
      const email = norm(r.email);
      return want.includes("@") ? email.includes(want) : Boolean(name) && (name.includes(want) || want.includes(name));
    });
  }
  if (target.kind === "stage") {
    const want = norm(target.label);
    if (!want) return snapshot.rows.filter((r) => isPlaceholderLabel(r.stage));
    // Exact-first, same as the stage page.
    const exact = snapshot.rows.filter((r) => norm(r.stage) === want);
    if (exact.length) return exact;
    return snapshot.rows.filter((r) => {
      const stage = norm(r.stage);
      return Boolean(stage) && (stage.includes(want) || want.includes(stage));
    });
  }
  if (target.kind === "kpi") {
    switch (target.id) {
      case "health":
        return snapshot.rows;
      case "completed":
        return snapshot.rows.filter((r) => r.terminal);
      case "ontime":
        return snapshot.rows.filter((r) => r.terminal && r.delay <= 0);
      case "delayed":
        return snapshot.rows.filter((r) => !r.terminal && (r.delay > 0 || r.bucket === "Delayed" || (r.tat > 0 && r.taken > r.tat)));
      case "overdue":
        return snapshot.rows.filter((r) => !r.terminal && r.delay > 0);
      case "tat":
        return snapshot.rows.filter((r) => !r.terminal && r.tat > 0 && r.taken > r.tat);
      case "risk":
        return snapshot.rows.filter((r) => !r.terminal && (r.delay > 30 || (r.delay > 0 && /critical|high/i.test(r.criticality))));
      case "remaining":
        return snapshot.rows.filter((r) => !r.terminal);
      case "notstarted":
        return snapshot.rows.filter((r) => !r.terminal && (r.bucket === "Not Started" || /not\s*started/i.test(r.status)));
    }
  }
  return [];
}

/** Human label for a verification target, used by the mismatch inspector. */
export function targetLabelFor(target: DashboardVerificationTarget): string {
  if (target.kind === "kpi") return `KPI · ${target.id}`;
  if (target.kind === "row") return `Row · ${target.key}`;
  return `${target.kind[0].toUpperCase()}${target.kind.slice(1)} · ${target.label || "—"}`;
}

/** Projects a live ScopedRow into the same shape stored in the dashboard snapshot. */
export function snapshotShapeFromScoped(row: ScopedRow): DashboardRowSnapshot {
  return {
    key: rowKeyForScoped(row),
    project: row.project,
    activity: row.activity,
    person: row.person,
    email: row.email,
    stage: row.stage,
    status: row.status,
    bucket: statusBucketForRow(row.row),
    terminal: isRowEffectivelyDone(row.row),
    tat: row.tat,
    taken: row.taken,
    delay: row.delay,
    criticality: String(row.row["Criticality"] ?? ""),
  };
}

const COMPARED_FIELDS: Array<keyof DashboardRowSnapshot> = [
  "project", "activity", "person", "email", "stage", "status", "bucket", "terminal", "tat", "taken", "delay",
];

export function verifyDashboardConsistency(
  actualRows: ScopedRow[],
  target: DashboardVerificationTarget,
  snapshot = readDashboardSnapshot(),
): DashboardConsistencyResult {
  const actualShaped = actualRows.map(snapshotShapeFromScoped);
  const label = targetLabelFor(target);

  if (!snapshot) {
    return {
      available: false,
      ok: true,
      expectedCount: 0,
      actualCount: actualRows.length,
      missingCount: 0,
      extraCount: 0,
      message: "No dashboard snapshot available for cross-check.",
      samples: [],
      targetLabel: label,
      missingKeys: [],
      extraKeys: [],
      fieldDiffs: [],
      canonicalRows: [],
      actualRows: actualShaped,
    };
  }

  const expected = expectedRowsForTarget(snapshot, target);
  const expectedKeys = expected.map((r) => r.key);
  const actualKeys = actualShaped.map((r) => r.key);
  const missing = subtractCounts(countKeys(expectedKeys), countKeys(actualKeys));
  const extra = subtractCounts(countKeys(actualKeys), countKeys(expectedKeys));

  // Field-level comparison for rows present on both sides: catches the class of
  // bug where the same row renders with a different status/TAT/delay downstream.
  // Duplicate row keys are possible when a sheet repeats a Sr. No./activity, so
  // compare per key as a multiset of field values rather than first-match — the
  // latter reports phantom diffs by pairing two unrelated duplicates.
  const groupBy = (rows: DashboardRowSnapshot[]) => {
    const m = new Map<string, DashboardRowSnapshot[]>();
    for (const r of rows) m.set(r.key, [...(m.get(r.key) ?? []), r]);
    return m;
  };
  const expectedByKey = groupBy(expected);
  const actualByKey = groupBy(actualShaped);
  const fieldDiffs: ConsistencyFieldDiff[] = [];
  for (const [key, wantGroup] of expectedByKey.entries()) {
    const gotGroup = actualByKey.get(key);
    if (!gotGroup) continue;
    for (const field of COMPARED_FIELDS) {
      const wantVals = wantGroup.map((r) => String(r[field] ?? "")).sort();
      const gotVals = gotGroup.map((r) => String(r[field] ?? "")).sort();
      if (wantVals.join("\u0001") === gotVals.join("\u0001")) continue;
      fieldDiffs.push({
        key,
        label: `${wantGroup[0].project} · ${wantGroup[0].activity}`,
        field: String(field),
        expected: wantVals.join(", ") || "—",
        actual: gotVals.join(", ") || "—",
      });
    }
  }

  const ok = missing.length === 0 && extra.length === 0 && expected.length === actualRows.length && fieldDiffs.length === 0;
  const labelsByKey = new Map(expected.map((r) => [r.key, `${r.project} · ${r.activity}`]));
  const samples = [...missing, ...extra].slice(0, 3).map((key) => labelsByKey.get(key) ?? key);

  return {
    available: true,
    ok,
    expectedCount: expected.length,
    actualCount: actualRows.length,
    missingCount: missing.length,
    extraCount: extra.length,
    signature: snapshot.signature,
    scopeLabel: snapshot.scopeLabel,
    savedAt: snapshot.savedAt,
    message: ok
      ? `Cross-verified with dashboard snapshot (${actualRows.length} row${actualRows.length === 1 ? "" : "s"}).`
      : fieldDiffs.length && missing.length === 0 && extra.length === 0
        ? `Same ${expected.length} row(s), but ${fieldDiffs.length} field(s) disagree with the dashboard.`
        : `Dashboard expected ${expected.length} row${expected.length === 1 ? "" : "s"}; this page loaded ${actualRows.length}.`,
    samples,
    targetLabel: label,
    missingKeys: missing,
    extraKeys: extra,
    fieldDiffs,
    canonicalRows: expected,
    actualRows: actualShaped,
  };
}

// ---------------------------------------------------------------------------
// Report log — every destination page records its verification outcome so the
// mismatch inspector (/agent/mismatch-inspector) can show what disagreed and
// which canonical rows each page actually used.
// ---------------------------------------------------------------------------

const REPORTS_KEY = "agent:consistency-reports:v1";
const MAX_REPORTS = 60;

export function readConsistencyReports(): ConsistencyReport[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(REPORTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConsistencyReport[]) : [];
  } catch {
    return [];
  }
}

export function clearConsistencyReports(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(REPORTS_KEY);
    window.dispatchEvent(new CustomEvent("agent:consistency-reports"));
  } catch { /* storage unavailable */ }
}

/** Records (or replaces) the verification outcome for one destination page. */
export function recordConsistencyReport(
  target: DashboardVerificationTarget,
  result: DashboardConsistencyResult,
  path?: string,
): void {
  if (typeof window === "undefined") return;
  const id = `${target.kind}:${target.kind === "kpi" ? target.id : target.kind === "row" ? target.key : target.label}`;
  const report: ConsistencyReport = {
    id,
    target,
    targetLabel: result.targetLabel,
    path: path ?? window.location.pathname,
    checkedAt: new Date().toISOString(),
    ok: result.ok,
    available: result.available,
    expectedCount: result.expectedCount,
    actualCount: result.actualCount,
    missingKeys: result.missingKeys,
    extraKeys: result.extraKeys,
    fieldDiffs: result.fieldDiffs,
    canonicalRows: result.canonicalRows.slice(0, 50),
    actualRows: result.actualRows.slice(0, 50),
    signature: result.signature,
    message: result.message,
  };
  try {
    const next = [report, ...readConsistencyReports().filter((r) => r.id !== id)].slice(0, MAX_REPORTS);
    window.sessionStorage.setItem(REPORTS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("agent:consistency-reports"));
  } catch { /* storage unavailable */ }
}
