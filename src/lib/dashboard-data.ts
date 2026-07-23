import { isSaneDuration } from "./eta-format";

export const DATA_URL =
  "https://depcheck.preview.emergentagent.com/api/public/jmiSUhAeUbD8Pr836wcY-3qgb9kmOXrW/export?fields=summary,totals,risk_score,status_breakdown,sheets,top_delay_reasons,correlation_matrix,dependency_chains,person_ranking,department_ranking,timeline_correlation,tat_performance,flags";

export interface PersonEntry {
  person: string;
  email?: string;
  phone?: string;
  delay_count: number;
  total_overdue_days: number;
  reasons: Record<string, number>;
  activities: string[];
}
export interface DeptEntry {
  department: string;
  delay_count: number;
  total_overdue_days: number;
  reasons: Record<string, number>;
}
export interface TatRow {
  activity: string;
  tat: number;
  days_taken: number;
  delta: number;
  overrun_pct: number;
  status: string;
  person: string;
}
export interface FlagEntry {
  id: string;
  type?: string;
  activity: string;
  flagged_to?: { person?: string; email?: string; phone?: string };
  reason?: string;
  reason_text?: string;
  tat?: number | null;
  days_taken?: number | null;
  overdue_days?: number | null;
  severity?: string;
  status?: string;
  stage?: string;
  criticality?: string;
  escalation_level?: number;
}
export interface DashboardData {
  summary: string;
  totals: { rows: number; delayed: number; blocked: number; completed: number; at_risk: number };
  risk_score: number;
  status_breakdown: Record<string, number>;
  top_delay_reasons: { reason: string; count: number; total_overdue_days: number }[];
  person_ranking: PersonEntry[];
  department_ranking: DeptEntry[];
  tat_performance: { rows: TatRow[] };
  flags?: FlagEntry[];
  mode_badge?: string;
  sheets?: { label: string; name: string; rows: number; columns: number }[];
}

export interface ExtraEntry {
  id: string;
  person: string;
  department: string;
  activity: string;
  reason: string;
  overdue_days: number;
  status: string;
  tat?: number;
  days_taken?: number;
}

export async function fetchDashboard(): Promise<DashboardData> {
  try {
    const res = await fetch(DATA_URL);
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.flags) && json.flags.length > 0) return json;
      // Static endpoint returned no flags — fall through to dynamic build.
    }
  } catch { /* fall through */ }
  // Static endpoint is dead or empty — build from the registered sheets so
  // alerts / flag detail pages don't strand users on "not found".
  const { buildDashboardFromSheets, listMyRegistryIds } = await import("./dashboard.functions");
  const sheetIds = await listMyRegistryIds();
  if (!sheetIds.length) throw new Error("No registered sheets yet.");
  return buildDashboardFromSheets({ data: { sheetIds } });
}

// Merge user-fed extras into base data, recomputing aggregates
export function mergeData(base: DashboardData, extras: ExtraEntry[]): DashboardData {
  if (!extras.length) return base;

  const totals = { ...base.totals, rows: base.totals.rows + extras.length };
  const status_breakdown = { ...base.status_breakdown };
  const reasonMap: Record<string, { count: number; days: number }> = {};
  base.top_delay_reasons.forEach((r) => {
    reasonMap[r.reason] = { count: r.count, days: r.total_overdue_days };
  });

  const personMap = new Map<string, PersonEntry>();
  base.person_ranking.forEach((p) => personMap.set(p.person, { ...p, reasons: { ...p.reasons }, activities: [...p.activities] }));
  const deptMap = new Map<string, DeptEntry>();
  base.department_ranking.forEach((d) => deptMap.set(d.department, { ...d, reasons: { ...d.reasons } }));

  for (const e of extras) {
    status_breakdown[e.status] = (status_breakdown[e.status] || 0) + 1;
    const isDelayed = e.status.toLowerCase() === "delayed" || e.overdue_days > 0;
    if (isDelayed) {
      totals.delayed += 1;
      if (!reasonMap[e.reason]) reasonMap[e.reason] = { count: 0, days: 0 };
      reasonMap[e.reason].count += 1;
      reasonMap[e.reason].days += e.overdue_days;

      const p = personMap.get(e.person) ?? {
        person: e.person, email: "", phone: "", delay_count: 0, total_overdue_days: 0, reasons: {}, activities: [],
      };
      p.delay_count += 1;
      p.total_overdue_days += e.overdue_days;
      p.reasons[e.reason] = (p.reasons[e.reason] || 0) + 1;
      if (e.activity && !p.activities.includes(e.activity)) p.activities.push(e.activity);
      personMap.set(e.person, p);

      const d = deptMap.get(e.department) ?? {
        department: e.department, delay_count: 0, total_overdue_days: 0, reasons: {},
      };
      d.delay_count += 1;
      d.total_overdue_days += e.overdue_days;
      d.reasons[e.reason] = (d.reasons[e.reason] || 0) + 1;
      deptMap.set(e.department, d);
    }
    if (e.status.toLowerCase() === "completed") totals.completed += 1;
  }

  const top_delay_reasons = Object.entries(reasonMap)
    .map(([reason, v]) => ({ reason, count: v.count, total_overdue_days: v.days }))
    .sort((a, b) => b.count - a.count);

  const person_ranking = [...personMap.values()].sort((a, b) => b.total_overdue_days - a.total_overdue_days);
  const department_ranking = [...deptMap.values()].sort((a, b) => b.total_overdue_days - a.total_overdue_days);

  // Guard the external TAT feed via the canonical isSaneDuration helper
  // (see src/lib/eta-format.ts for tests covering serial-date leaks etc.).
  const tatExtras: TatRow[] = extras
    .filter((e) => isSaneDuration(e.tat) && isSaneDuration(e.days_taken))
    .map((e) => ({
      activity: e.activity,
      tat: e.tat!,
      days_taken: e.days_taken!,
      delta: (e.days_taken! - e.tat!),
      overrun_pct: e.tat ? ((e.days_taken! - e.tat!) / e.tat!) * 100 : 0,
      status: e.status,
      person: e.person,
    }));

  return {
    ...base,
    totals,
    status_breakdown,
    top_delay_reasons,
    person_ranking,
    department_ranking,
    tat_performance: { rows: [...tatExtras, ...base.tat_performance.rows] },
    summary: `${totals.rows} rows analysed. ${totals.delayed} delayed. ${totals.blocked} blocked downstream.`,
  };
}
