import { describe, it, expect } from "vitest";
import { mergeData, type DashboardData, type ExtraEntry } from "@/lib/dashboard-data";
import {
  computeRowStatus,
  isRowEffectivelyDone,
  isTerminalRow,
  sanitizeDuration,
  sanitizedDelayDays,
  statusBucketForRow,
} from "@/lib/status-utils";
import { buildRowQualityReport } from "@/lib/row-quality";
import { formatEtaDays, isSaneDuration } from "@/lib/eta-format";

/**
 * End-to-end accuracy regression: simulate a real ingest cycle from a mocked
 * external feed containing the full menagerie of poison values we've hit in
 * production, then walk the payload through every sanitization layer the UI
 * depends on. If this test fails, the dashboard can visibly regress on:
 *
 *   • ETA rendering (the "1159d" family)
 *   • TAT feed containing serial-date leaks
 *   • Rows silently promoted to Completed by a stray date serial
 *   • Delay-days aggregation counting a date as a duration
 *   • Row-quality summary under-counting rejected rows
 */

// A minimal but realistic base payload — mirrors what /api/public/... returns.
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

/**
 * Mocked external feed — mixes:
 *   - 2 clean rows (should be accepted everywhere)
 *   - 4 poisoned rows (each triggers a different guard)
 */
const FEED: ExtraEntry[] = [
  // ── Clean ────────────────────────────────────────────────────────────────
  { id: "OK-1", person: "A", department: "Ops",   activity: "Survey",   reason: "-",       overdue_days: 0,  status: "Completed", tat: 10,  days_taken: 9 },
  { id: "OK-2", person: "B", department: "Civil", activity: "Erection", reason: "Weather", overdue_days: 5,  status: "Delayed",   tat: 30,  days_taken: 35 },

  // ── Poison ──────────────────────────────────────────────────────────────
  // Google Sheets serial leaked into TAT (≈ 2025-11-05)
  { id: "BAD-1", person: "C", department: "Civil", activity: "Foundation", reason: "Vendor",   overdue_days: 3,  status: "Delayed",   tat: 45963, days_taken: 12 },
  // Serial leaked into Days Taken
  { id: "BAD-2", person: "D", department: "Elec",  activity: "Testing",    reason: "Access",   overdue_days: 7,  status: "Delayed",   tat: 20,    days_taken: 46028 },
  // Impossible multi-year duration (bug seed for "ETA 1159d"). Both fields
  // must exceed the 3650-day guard to be rejected end-to-end.
  { id: "BAD-3", person: "E", department: "Ops",   activity: "Handover",   reason: "Approval", overdue_days: 12, status: "Delayed",   tat: 5000,  days_taken: 6000 },
  // Negative TAT
  { id: "BAD-4", person: "F", department: "Civil", activity: "Backfill",   reason: "Rework",   overdue_days: 0,  status: "In Progress", tat: -5,  days_taken: 3 },
];

// Raw sheet rows (what the dashboard actually renders per-row). Same story:
// mix clean and poisoned rows so the row-quality report has predictable counts.
const RAW_ROWS: Array<Record<string, unknown>> = [
  { ID: "R-OK",   Status: "Completed",   TAT: 10, "Days Taken": 9,     "Delay in Days": 0 },
  { ID: "R-OK-2", Status: "In Progress", TAT: 30, "Days Taken": 20,    "Delay in Days": 0 },
  { ID: "R-SER-TAT",  Status: "In Progress", TAT: 45963, "Days Taken": 5, "Delay in Days": 0 },
  { ID: "R-SER-DT",   Status: "Delayed",     TAT: 20,    "Days Taken": 46028, "Delay in Days": 0 },
  { ID: "R-SER-DEL",  Status: "Delayed",     TAT: 20,    "Days Taken": 25, "Delay in Days": 46100 },
  { ID: "R-NEG",      Status: "In Progress", TAT: -3,    "Days Taken": 5, "Delay in Days": 0 },
  { ID: "R-MISSING",  Status: "In Progress" }, // missing TAT + Days Taken on active row
];

describe("End-to-end accuracy pipeline (mocked feed → dashboard surfaces)", () => {
  const merged = mergeData(BASE, FEED);

  // ── TAT feed guard ─────────────────────────────────────────────────────
  it("mergeData accepts only sane TAT/Days Taken pairs", () => {
    const acceptedIds = merged.tat_performance.rows.map((r) =>
      // TatRow doesn't carry id — match by activity+person from the seed.
      `${r.activity}|${r.person}`,
    );
    // Only the two clean rows should reach the KPI feed.
    expect(merged.tat_performance.rows).toHaveLength(2);
    expect(acceptedIds).toEqual(
      expect.arrayContaining(["Survey|A", "Erection|B"]),
    );
    // No poisoned row leaks through.
    expect(acceptedIds.some((k) => k.startsWith("Foundation|"))).toBe(false);
    expect(acceptedIds.some((k) => k.startsWith("Testing|"))).toBe(false);
    expect(acceptedIds.some((k) => k.startsWith("Handover|"))).toBe(false);
    expect(acceptedIds.some((k) => k.startsWith("Backfill|"))).toBe(false);
  });

  it("exposes a computable rejected-rows count matching poison in the feed", () => {
    const accepted = merged.tat_performance.rows.length;
    // Rows with numeric tat/days_taken in the feed (excluding the two clean ones)
    const numericPoisoned = FEED.filter(
      (e) => typeof e.tat === "number" && typeof e.days_taken === "number",
    ).length - accepted;
    expect(numericPoisoned).toBe(4);
    // Direct check via the same predicate mergeData uses.
    const rejected = FEED.filter(
      (e) => !(isSaneDuration(e.tat) && isSaneDuration(e.days_taken)),
    );
    expect(rejected).toHaveLength(4);
    expect(rejected.map((r) => r.id)).toEqual(["BAD-1", "BAD-2", "BAD-3", "BAD-4"]);
  });

  it("no accepted TAT row can produce a bogus ETA when rendered", () => {
    for (const row of merged.tat_performance.rows) {
      // Simulate the ETA projection input: days_taken * clamp factor.
      const projection = sanitizeDuration(row.days_taken) * 2;
      expect(formatEtaDays(projection)).not.toBe("1159d");
      // Rendered label is always in the safe alphabet.
      const label = formatEtaDays(projection);
      expect(label === "—" || label === "365d+" || /^\d+d$/.test(label)).toBe(true);
    }
  });

  // ── Row-level status accuracy ──────────────────────────────────────────
  it("computeRowStatus clamps every serial-date leak to zero", () => {
    const serTat = computeRowStatus(RAW_ROWS[2]);
    const serDt = computeRowStatus(RAW_ROWS[3]);
    const serDel = computeRowStatus(RAW_ROWS[4]);
    expect(serTat.tat).toBe(0);
    expect(serDt.taken).toBe(0);
    // The 46100 serial in "Delay in Days" is discarded; any surviving delay
    // comes only from the TAT-vs-taken breach (25 − 20 = 5), never the leak.
    expect(serDel.delay).toBe(5);
    expect(serDel.delay).toBeLessThan(100);
  });

  it("keeps an explicitly-active row out of Completed even with a stray date serial", () => {
    // R-SER-DT has Status='Delayed' but Days Taken = date serial. It must
    // stay in Delayed, not silently jump to Completed.
    const bucket = statusBucketForRow(RAW_ROWS[3]);
    expect(bucket).toBe("Delayed");
    expect(isRowEffectivelyDone(RAW_ROWS[3])).toBe(false);
    expect(isTerminalRow(RAW_ROWS[3])).toBe(false);
  });

  it("sanitizedDelayDays collapses date serials to 0 and preserves real delays", () => {
    expect(sanitizedDelayDays(RAW_ROWS[4])).toBe(0);          // serial leak
    expect(sanitizedDelayDays({ "Delay in Days": 12 })).toBe(12);
    expect(sanitizedDelayDays({ "Delay in Days": -8 })).toBe(0);
    expect(sanitizedDelayDays({ Status: "Delay by 59 days" })).toBe(59);
  });

  // ── Row-quality report parity ──────────────────────────────────────────
  it("row-quality report flags every poison and both missing-duration cells", () => {
    const report = buildRowQualityReport(RAW_ROWS);
    // 5 poisoned rows: SER-TAT, SER-DT, SER-DEL, NEG, MISSING
    expect(report.rowsWithIssues).toBe(5);
    expect(report.counts.date_serial_in_tat).toBe(1);
    expect(report.counts.date_serial_in_days_taken).toBe(1);
    expect(report.counts.date_serial_in_delay).toBe(1);
    expect(report.counts.negative_duration).toBe(1);
    expect(report.counts.missing_tat).toBe(1);
    expect(report.counts.missing_days_taken).toBe(1);
    // Total row count stays honest.
    expect(report.totalRows).toBe(RAW_ROWS.length);
  });

  // ── Cross-layer invariant: no path renders > 365d ──────────────────────
  it("even a worst-case merged projection cannot render a multi-year ETA", () => {
    const worstCase = Math.max(
      1159,
      ...FEED.map((e) => (typeof e.tat === "number" ? e.tat : 0)),
      ...FEED.map((e) => (typeof e.days_taken === "number" ? e.days_taken : 0)),
    );
    expect(worstCase).toBeGreaterThan(365);
    expect(formatEtaDays(worstCase)).toBe("365d+");
    // Same worst case after passing through sanitizeDuration collapses safely.
    expect(formatEtaDays(sanitizeDuration(worstCase))).toBe("—");
  });

  // ── Delayed totals are not inflated by poisoned rows ───────────────────
  it("merged totals still count delays, but poisoned rows never enter TAT KPI", () => {
    // 5 of 6 extras are delayed (>0 overdue_days OR status=delayed).
    expect(merged.totals.delayed).toBe(5);
    // Only 2 rows in the TAT KPI feed (the two clean numeric pairs).
    expect(merged.tat_performance.rows).toHaveLength(2);
    // Completed is 1 (OK-1).
    expect(merged.totals.completed).toBe(1);
  });
});
