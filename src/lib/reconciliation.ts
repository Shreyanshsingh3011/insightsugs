// Pure reconciliation math shared by the server function and the dashboard
// widget. Given a set of merged sheet rows, computes per-row discrepancy
// (planned − consumed / received) and aggregates it by status bucket, time
// bucket, and top delay reasons. Also reports which of the expected columns
// were missing so the UI/chat can explain when a value could not be derived.

import { statusBucketForRow } from "./status-utils";

export type ReconciliationRow = {
  rowIndex: number;
  label: string;
  status: string;
  planned: number | null;
  consumed: number | null;
  received: number | null;
  balance: number | null;
  /** planned − consumed (falls back to planned − received when consumed missing) */
  discrepancy: number | null;
  /** discrepancy / planned × 100 */
  variancePct: number | null;
  reason: string;
  updatedAt: string | null;
};

export type ReconciliationBucket = { key: string; count: number; totalDiscrepancy: number };

export type ReconciliationSummary = {
  rowsScanned: number;
  rowsWithDiscrepancy: number;
  totalPlanned: number;
  totalConsumed: number;
  totalReceived: number;
  netDiscrepancy: number;
  averageVariancePct: number | null;
  byStatus: ReconciliationBucket[];
  byTimeBucket: ReconciliationBucket[];
  topReasons: ReconciliationBucket[];
  columnsUsed: Record<"planned" | "consumed" | "received" | "balance" | "label" | "reason" | "updated", string | null>;
  missingColumns: string[];
  derivedFields: string[];
  rows: ReconciliationRow[];
};

const PLANNED_RE = /^(planned[_ ]?(qty|quantity|units|amount)|budgeted[_ ]?(qty|quantity)|target[_ ]?(qty|quantity))$/i;
const CONSUMED_RE = /^(consumed[_ ]?(qty|quantity|units)|used[_ ]?(qty|quantity)|utili[sz]ed[_ ]?(qty|quantity))$/i;
const RECEIVED_RE = /^(received[_ ]?(qty|quantity|units)|delivered[_ ]?(qty|quantity)|actual[_ ]?(qty|quantity))$/i;
const BALANCE_RE = /^(balance|remaining|stock[_ ]?on[_ ]?hand|closing[_ ]?balance)$/i;
const LABEL_RE = /^(material|item|sku|component|activity|project|name|title)$/i;
const REASON_RE = /^(remarks?|reason|comments?|notes?|discrepancy[_ ]?reason)$/i;
const UPDATED_RE = /^(updated[_ ]?at|updated|last[_ ]?updated|received[_ ]?date|entry[_ ]?date|date)$/i;

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,₹$€£%()\s]/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function pickCol(cols: string[], re: RegExp): string | null {
  return cols.find((c) => re.test(c)) ?? null;
}

function timeBucket(iso: string | null): string {
  if (!iso) return "Undated";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Undated";
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days <= 7) return "Last 7 days";
  if (days <= 30) return "Last 30 days";
  if (days <= 90) return "Last 90 days";
  if (days <= 365) return "Last year";
  return "Older";
}

export function computeReconciliation(rows: Record<string, unknown>[]): ReconciliationSummary {
  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cols = {
    planned: pickCol(columns, PLANNED_RE),
    consumed: pickCol(columns, CONSUMED_RE),
    received: pickCol(columns, RECEIVED_RE),
    balance: pickCol(columns, BALANCE_RE),
    label: pickCol(columns, LABEL_RE),
    reason: pickCol(columns, REASON_RE),
    updated: pickCol(columns, UPDATED_RE),
  };

  const missing: string[] = [];
  if (!cols.planned) missing.push("planned_qty");
  if (!cols.consumed && !cols.received) missing.push("consumed_qty or received_qty");
  const derived: string[] = [];
  if (cols.planned && cols.consumed) derived.push("discrepancy = planned_qty − consumed_qty");
  else if (cols.planned && cols.received) derived.push("discrepancy = planned_qty − received_qty (consumed_qty missing)");
  else if (cols.planned && cols.balance) derived.push("discrepancy = planned_qty − (planned_qty − balance)");

  const out: ReconciliationRow[] = [];
  let totalPlanned = 0, totalConsumed = 0, totalReceived = 0;
  const statusAcc = new Map<string, { count: number; total: number }>();
  const timeAcc = new Map<string, { count: number; total: number }>();
  const reasonAcc = new Map<string, { count: number; total: number }>();
  const variances: number[] = [];

  rows.forEach((r, i) => {
    const planned = cols.planned ? num(r[cols.planned]) : null;
    const consumed = cols.consumed ? num(r[cols.consumed]) : null;
    const received = cols.received ? num(r[cols.received]) : null;
    const balance = cols.balance ? num(r[cols.balance]) : null;

    let discrepancy: number | null = null;
    if (planned != null && consumed != null) discrepancy = planned - consumed;
    else if (planned != null && received != null) discrepancy = planned - received;
    else if (planned != null && balance != null) discrepancy = balance; // balance IS the delta

    const variancePct = discrepancy != null && planned != null && planned !== 0
      ? (discrepancy / planned) * 100
      : null;

    const status = statusBucketForRow(r as Record<string, string>) || "Unknown";
    const updatedAt = cols.updated ? (r[cols.updated] as string) ?? null : null;
    const reason = cols.reason ? String(r[cols.reason] ?? "").trim() : "";
    const label = cols.label
      ? String(r[cols.label] ?? "").trim() || `Row ${i + 1}`
      : `Row ${i + 1}`;

    if (planned != null) totalPlanned += planned;
    if (consumed != null) totalConsumed += consumed;
    if (received != null) totalReceived += received;

    if (discrepancy != null && discrepancy !== 0) {
      const magnitude = Math.abs(discrepancy);
      const s = statusAcc.get(status) ?? { count: 0, total: 0 };
      s.count += 1; s.total += magnitude; statusAcc.set(status, s);

      const tb = timeBucket(updatedAt);
      const t = timeAcc.get(tb) ?? { count: 0, total: 0 };
      t.count += 1; t.total += magnitude; timeAcc.set(tb, t);

      if (reason) {
        const rz = reasonAcc.get(reason) ?? { count: 0, total: 0 };
        rz.count += 1; rz.total += magnitude; reasonAcc.set(reason, rz);
      }
      if (variancePct != null) variances.push(Math.abs(variancePct));
    }

    out.push({
      rowIndex: i,
      label,
      status,
      planned,
      consumed,
      received,
      balance,
      discrepancy,
      variancePct,
      reason,
      updatedAt,
    });
  });

  const toBuckets = (m: Map<string, { count: number; total: number }>): ReconciliationBucket[] =>
    Array.from(m.entries())
      .map(([key, v]) => ({ key, count: v.count, totalDiscrepancy: v.total }))
      .sort((a, b) => b.totalDiscrepancy - a.totalDiscrepancy);

  return {
    rowsScanned: rows.length,
    rowsWithDiscrepancy: out.filter((r) => r.discrepancy != null && r.discrepancy !== 0).length,
    totalPlanned,
    totalConsumed,
    totalReceived,
    netDiscrepancy: totalPlanned - (totalConsumed || totalReceived),
    averageVariancePct: variances.length ? variances.reduce((a, b) => a + b, 0) / variances.length : null,
    byStatus: toBuckets(statusAcc),
    byTimeBucket: toBuckets(timeAcc),
    topReasons: toBuckets(reasonAcc).slice(0, 5),
    columnsUsed: cols,
    missingColumns: missing,
    derivedFields: derived,
    rows: out,
  };
}
