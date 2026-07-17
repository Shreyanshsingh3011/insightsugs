import { describe, it, expect } from "vitest";
import { mergeData, type DashboardData, type ExtraEntry } from "@/lib/dashboard-data";
import {
  computeRowStatus,
  isRowEffectivelyDone,
  sanitizeDuration,
  sanitizedDelayDays,
  statusBucketForRow,
} from "@/lib/status-utils";
import { buildRowQualityReport } from "@/lib/row-quality";
import { formatEtaDays, isSaneDuration } from "@/lib/eta-format";

/**
 * Nightly regression: replays the accuracy pipeline against a *large* mocked
 * feed (1000+ rows) with a deterministic poison distribution. The nightly CI
 * job runs this to catch statistical regressions the small in-tree feed can
 * miss (e.g. a guard that lets through 1 in 500 serial leaks).
 *
 * Invariants asserted here must ALL hold — a failure blocks the nightly
 * status check in GitHub.
 */

const BASE: DashboardData = {
  summary: "seed",
  totals: { rows: 0, delayed: 0, blocked: 0, completed: 0, at_risk: 0 },
  risk_score: 0,
  status_breakdown: {},
  top_delay_reasons: [],
  person_ranking: [],
  department_ranking: [],
  tat_performance: { rows: [] },
  flags: [],
};

const SIZE = 1200;

// Deterministic PRNG so the "large mock feed" is stable across runs.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

type Poison =
  | "clean"
  | "serial_tat"
  | "serial_days"
  | "serial_delay"
  | "impossible_tat"
  | "negative_tat"
  | "missing_durations";

const POISON_MIX: Array<[Poison, number]> = [
  ["clean", 0.60],
  ["serial_tat", 0.08],
  ["serial_days", 0.08],
  ["serial_delay", 0.06],
  ["impossible_tat", 0.06],
  ["negative_tat", 0.06],
  ["missing_durations", 0.06],
];

function pickPoison(r: number): Poison {
  let acc = 0;
  for (const [kind, p] of POISON_MIX) {
    acc += p;
    if (r < acc) return kind;
  }
  return "clean";
}

const rand = rng(0xC0FFEE);
const FEED: ExtraEntry[] = [];
const RAW_ROWS: Array<Record<string, unknown>> = [];
const distribution: Record<Poison, number> = {
  clean: 0, serial_tat: 0, serial_days: 0, serial_delay: 0,
  impossible_tat: 0, negative_tat: 0, missing_durations: 0,
};

for (let i = 0; i < SIZE; i++) {
  const kind = pickPoison(rand());
  distribution[kind]++;

  const base = {
    id: `N-${i}`,
    person: `P${i % 40}`,
    department: ["Ops", "Civil", "Elec", "Testing"][i % 4],
    activity: `Act-${i}`,
    reason: "auto",
    overdue_days: i % 15,
    status: kind === "clean" && i % 3 === 0 ? "Completed" : "Delayed",
  };

  switch (kind) {
    case "clean":
      FEED.push({ ...base, tat: 10 + (i % 40), days_taken: 8 + (i % 35) });
      RAW_ROWS.push({ ID: `R-${i}`, Status: base.status, TAT: 20, "Days Taken": 18, "Delay in Days": 0 });
      break;
    case "serial_tat":
      FEED.push({ ...base, tat: 45000 + (i % 2000), days_taken: 12 });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "In Progress", TAT: 45963, "Days Taken": 5, "Delay in Days": 0 });
      break;
    case "serial_days":
      FEED.push({ ...base, tat: 20, days_taken: 46000 + (i % 500) });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "Delayed", TAT: 20, "Days Taken": 46028, "Delay in Days": 0 });
      break;
    case "serial_delay":
      FEED.push({ ...base, tat: 20, days_taken: 25 });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "Delayed", TAT: 20, "Days Taken": 25, "Delay in Days": 46100 });
      break;
    case "impossible_tat":
      FEED.push({ ...base, tat: 5000 + (i % 3000), days_taken: 6000 + (i % 3000) });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "Delayed", TAT: 5000, "Days Taken": 6000, "Delay in Days": 200 });
      break;
    case "negative_tat":
      FEED.push({ ...base, tat: -1 - (i % 20), days_taken: 5 });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "In Progress", TAT: -5, "Days Taken": 5, "Delay in Days": 0 });
      break;
    case "missing_durations":
      FEED.push({ ...base, tat: undefined as unknown as number, days_taken: undefined as unknown as number });
      RAW_ROWS.push({ ID: `R-${i}`, Status: "In Progress" });
      break;
  }
}

describe(`Nightly accuracy pipeline @ ${SIZE} rows`, () => {
  const merged = mergeData(BASE, FEED);

  it("only clean rows reach the TAT KPI feed", () => {
    expect(merged.tat_performance.rows.length).toBe(distribution.clean);
  });

  it("every rejected row fails the sane-duration predicate", () => {
    const rejected = FEED.filter(
      (e) => !(isSaneDuration(e.tat) && isSaneDuration(e.days_taken)),
    );
    expect(rejected.length).toBe(SIZE - distribution.clean);
    // Zero-tolerance: NOT ONE poisoned row may sneak in.
    for (const row of merged.tat_performance.rows) {
      expect(isSaneDuration(row.tat)).toBe(true);
      expect(isSaneDuration(row.days_taken)).toBe(true);
    }
  });

  it("no accepted TAT row can render a multi-year ETA", () => {
    for (const row of merged.tat_performance.rows) {
      const projection = sanitizeDuration(row.days_taken) * 2;
      const label = formatEtaDays(projection);
      expect(label === "—" || label === "365d+" || /^\d+d$/.test(label)).toBe(true);
      // Regression guard for the "1159d" family.
      expect(label).not.toMatch(/^(?:[4-9]\d{2}|\d{4,})d$/);
    }
  });

  it("computeRowStatus clamps every serial-leak row to sane numbers", () => {
    for (const raw of RAW_ROWS) {
      const s = computeRowStatus(raw);
      expect(s.tat).toBeLessThan(3650);
      expect(s.taken).toBeLessThan(3650);
      expect(s.delay).toBeLessThan(3650);
    }
  });

  it("no explicitly-active row is silently promoted to Completed", () => {
    for (const raw of RAW_ROWS) {
      const status = String(raw.Status ?? "");
      if (/delayed|in progress/i.test(status)) {
        expect(statusBucketForRow(raw)).not.toBe("Completed");
        expect(isRowEffectivelyDone(raw)).toBe(false);
      }
    }
  });

  it("sanitizedDelayDays never returns a serial-date value", () => {
    for (const raw of RAW_ROWS) {
      const d = sanitizedDelayDays(raw);
      expect(d).toBeLessThan(3650);
      expect(d).toBeGreaterThanOrEqual(0);
    }
  });

  it("row-quality report counts match the deterministic poison distribution", () => {
    const report = buildRowQualityReport(RAW_ROWS);
    expect(report.totalRows).toBe(RAW_ROWS.length);
    expect(report.counts.date_serial_in_tat).toBe(distribution.serial_tat);
    expect(report.counts.date_serial_in_days_taken).toBe(distribution.serial_days);
    expect(report.counts.date_serial_in_delay).toBe(distribution.serial_delay);
    expect(report.counts.negative_duration).toBe(distribution.negative_tat);
    // Missing-duration rows contribute to both missing_tat and missing_days_taken.
    expect(report.counts.missing_tat).toBe(distribution.missing_durations);
    expect(report.counts.missing_days_taken).toBe(distribution.missing_durations);
  });

  it("totals stay internally consistent", () => {
    expect(merged.totals.completed).toBeGreaterThan(0);
    expect(merged.totals.delayed).toBeGreaterThan(0);
    // Delayed count comes from the feed's status/overdue signal, independent
    // of TAT poison — but must never exceed the feed size.
    expect(merged.totals.delayed).toBeLessThanOrEqual(SIZE);
  });
});
