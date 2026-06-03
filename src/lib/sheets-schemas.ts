// Canonical schemas for each sheet type. Client-safe.

export type SheetType =
  | "progress"
  | "material_reconciliation"
  | "procurement"
  | "contractor_billing"
  | "bill_tracking"
  | "pms"
  | "tat";

export const SHEET_TYPE_LABELS: Record<SheetType, string> = {
  progress: "Progress",
  material_reconciliation: "Material Reconciliation",
  procurement: "Procurement",
  contractor_billing: "Contractor Billing",
  bill_tracking: "Bill Tracking",
  pms: "PMS",
  tat: "TAT",
};

export const CANONICAL_FIELDS: Record<SheetType, string[]> = {
  progress: [
    "activity", "owner", "dept",
    "planned_start", "planned_end", "actual_start", "actual_end",
    "status", "percent_complete", "remarks",
  ],
  material_reconciliation: [
    "material", "uom", "planned_qty", "received_qty", "consumed_qty",
    "balance", "variance", "remarks",
  ],
  procurement: [
    "item", "vendor", "po_no", "po_date",
    "expected_date", "received_date", "status", "remarks",
  ],
  contractor_billing: [
    "contractor", "bill_no", "bill_date",
    "amount_claimed", "amount_certified", "amount_paid", "status", "remarks",
  ],
  bill_tracking: [
    "bill_no", "vendor", "received_date", "due_date",
    "approver", "paid_date", "status", "amount", "remarks",
  ],
  pms: [
    "kpi", "owner", "period", "target", "actual", "variance", "status", "remarks",
  ],
  tat: [
    "activity", "owner", "dept", "start_date", "due_date",
    "completion_date", "tat_days", "sla_days", "breach", "remarks",
  ],
};

export const SHEET_TYPES: SheetType[] = [
  "progress", "material_reconciliation", "procurement",
  "contractor_billing", "bill_tracking", "pms", "tat",
];
