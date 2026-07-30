import { encodeRowKey, isPlaceholderLabel, rowIdent, toScopedRow, type Row, type ScopedRow } from "@/lib/entity-scope";
import { isRowEffectivelyDone, statusBucketForRow } from "@/lib/status-utils";

const SNAPSHOT_KEY = "agent:dashboard-snapshot:v1";

export type DashboardVerificationTarget =
  | { kind: "row"; key: string }
  | { kind: "person"; label: string }
  | { kind: "stage"; label: string }
  | { kind: "project"; label: string }
  | { kind: "kpi"; id: "health" | "ontime" | "overdue" | "tat" | "risk" | "notstarted" };

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
    return snapshot.rows.filter((r) => {
      const name = norm(r.person);
      const email = norm(r.email);
      return name === want || email === want || (name && (name.includes(want) || want.includes(name)));
    });
  }
  if (target.kind === "stage") {
    const want = norm(target.label);
    if (!want) return snapshot.rows.filter((r) => isPlaceholderLabel(r.stage));
    return snapshot.rows.filter((r) => {
      const stage = norm(r.stage);
      return stage === want || (stage && (stage.includes(want) || want.includes(stage)));
    });
  }
  if (target.kind === "kpi") {
    switch (target.id) {
      case "health":
        return snapshot.rows;
      case "ontime":
        return snapshot.rows.filter((r) => r.terminal && r.delay <= 0);
      case "overdue":
        return snapshot.rows.filter((r) => !r.terminal && r.delay > 0);
      case "tat":
        return snapshot.rows.filter((r) => !r.terminal && r.tat > 0 && r.taken > r.tat);
      case "risk":
        return snapshot.rows.filter((r) => !r.terminal && (r.delay > 30 || (r.delay > 0 && /critical|high/i.test(r.criticality))));
      case "notstarted":
        return snapshot.rows.filter((r) => !r.terminal && (r.bucket === "Not Started" || /not\s*started/i.test(r.status)));
    }
  }
  return [];
}

export function verifyDashboardConsistency(
  actualRows: ScopedRow[],
  target: DashboardVerificationTarget,
  snapshot = readDashboardSnapshot(),
): DashboardConsistencyResult {
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
    };
  }

  const expected = expectedRowsForTarget(snapshot, target);
  const expectedKeys = expected.map((r) => r.key);
  const actualKeys = actualRows.map(rowKeyForScoped);
  const missing = subtractCounts(countKeys(expectedKeys), countKeys(actualKeys));
  const extra = subtractCounts(countKeys(actualKeys), countKeys(expectedKeys));
  const ok = missing.length === 0 && extra.length === 0 && expected.length === actualRows.length;
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
      : `Dashboard expected ${expected.length} row${expected.length === 1 ? "" : "s"}; this page loaded ${actualRows.length}.`,
    samples,
  };
}