import { describe, expect, it } from "vitest";
import { buildDashboardSnapshot, expectedRowsForTarget, verifyDashboardConsistency } from "@/lib/dashboard-consistency";
import { toScopedRow, type Row } from "@/lib/entity-scope";

function row(over: Partial<Row> = {}): Row {
  return {
    __project: "NIT-58",
    "Sr. No.": "1",
    "Activity List": "Submit drawing",
    "Responsible Person": "Yash",
    "Stages": "Pre-Tender",
    Status: "In Progress",
    TAT: "10",
    "Days Taken": "12",
    "Delay in Days": "2",
    Criticality: "High",
    ...over,
  };
}

describe("dashboard consistency snapshot", () => {
  it("uses the same completed bucket that the Completed card displays", () => {
    const rows = [
      row({ "Sr. No.": "1", Status: "Completed", "Days Taken": "8", "Delay in Days": "0" }),
      row({ "Sr. No.": "2", Status: "Completed", "Days Taken": "14", "Delay in Days": "4" }),
      row({ "Sr. No.": "3", Status: "In Progress", "Delay in Days": "2" }),
    ];
    const snap = buildDashboardSnapshot(rows, { scopeLabel: "NIT-58", selected: "nit58", focusPerson: "all", focusDept: "all" });
    expect(expectedRowsForTarget(snap, { kind: "kpi", id: "completed" })).toHaveLength(2);
    expect(expectedRowsForTarget(snap, { kind: "kpi", id: "ontime" })).toHaveLength(1);
  });

  it("detects when a destination page loaded a different row set", () => {
    const rows = [row({ "Sr. No.": "1" }), row({ "Sr. No.": "2", "Activity List": "Approval", "Delay in Days": "5" })];
    const snap = buildDashboardSnapshot(rows, { scopeLabel: "NIT-58", selected: "nit58", focusPerson: "all", focusDept: "all" });
    const actual = [toScopedRow(rows[0], 0, "NIT-58")];
    const result = verifyDashboardConsistency(actual, { kind: "kpi", id: "delayed" }, snap);
    expect(result.ok).toBe(false);
    expect(result.expectedCount).toBe(2);
    expect(result.actualCount).toBe(1);
  });

  it("cross-verifies a matching project page row set", () => {
    const rows = [row({ "Sr. No.": "1" }), row({ "Sr. No.": "2", "Activity List": "Approval" })];
    const snap = buildDashboardSnapshot(rows, { scopeLabel: "NIT-58", selected: "nit58", focusPerson: "all", focusDept: "all" });
    const actual = rows.map((r, i) => toScopedRow(r, i, "NIT-58"));
    const result = verifyDashboardConsistency(actual, { kind: "project", label: "NIT-58" }, snap);
    expect(result.ok).toBe(true);
    expect(result.expectedCount).toBe(2);
  });
});