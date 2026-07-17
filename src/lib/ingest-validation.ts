// Client-safe row validation for the ingest preview. Runs before the user
// commits so they can see exactly which rows / columns will land as empty,
// which required canonical fields are unmapped, and which cells failed a
// simple type check (dates, numbers, currency).

import { CANONICAL_FIELDS, type SheetType } from "@/lib/sheets-schemas";

export type RowIssue = {
  rowIndex: number;              // 0-based, matches sheet_rows.row_index
  header: string;                // source column
  canonical: string | null;      // mapped canonical field (null = extra)
  value: string;                 // raw cell text (truncated)
  kind: "empty_required" | "bad_date" | "bad_number" | "duplicate_key" | "date_serial_in_duration";
  message: string;
};

export type ValidationSummary = {
  totalRows: number;
  rowsWithIssues: number;
  issues: RowIssue[];           // capped at 500 for UI
  unmappedRequired: string[];   // canonical fields with no header mapped
  duplicateHeaders: string[];
  emptyHeaders: number;
};

// Canonical fields that should be present for each sheet type. Kept
// conservative so we surface real gaps without over-flagging optional cols.
const REQUIRED_FIELDS: Partial<Record<SheetType, string[]>> = {
  progress: ["activity", "status"],
  material_reconciliation: ["material"],
  procurement: ["item", "vendor"],
  contractor_billing: ["contractor", "bill_no"],
  bill_tracking: ["bill_no", "vendor"],
  pms: ["kpi"],
  tat: ["activity", "start_date"],
};

const DATE_FIELDS = /(_date$|^date_|_start$|_end$|_on$)/i;
const NUMBER_FIELDS = /(amount|qty|percent|days|target|actual|variance|balance)/i;
// Canonical fields that must be plain day counts — any Excel date-serial
// value (≈30000-70000) in these columns is a formatting leak, not a duration.
const DURATION_FIELDS = /^(tat_days|days_taken|delay_in_days|sla_days)$/i;

function isDateish(s: string): boolean {
  const t = s.trim();
  if (!t) return true; // empty allowed here; empty_required is separate
  // Excel serial: bounded to plausible range (1900-01-01 ≈ 1 → 2100 ≈ 73415)
  if (/^\d{4,5}(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n >= 1 && n <= 80000) return true;
  }
  if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && !Number.isNaN(Date.parse(t))) return true;
  // Only accept named-month formats via Date.parse to avoid false positives on plain numbers
  if (/[A-Za-z]/.test(t) && !Number.isNaN(Date.parse(t))) return true;
  return false;
}

function isNumberish(s: string): boolean {
  if (!s.trim()) return true;
  const cleaned = s.replace(/[,₹$€£%()\s]/g, "");
  return /^-?\d+(\.\d+)?$/.test(cleaned);
}

export function validateParsedTable(input: {
  sheetType: SheetType;
  headers: string[];
  rows: string[][];
  mapping: Record<string, string | null>;
}): ValidationSummary {
  const { sheetType, headers, rows, mapping } = input;
  const required = REQUIRED_FIELDS[sheetType] ?? [];
  const canonicalAll = CANONICAL_FIELDS[sheetType];

  // Header-level checks
  const emptyHeaders = headers.filter((h) => !h || !h.trim()).length;
  const seenHdr = new Map<string, number>();
  const duplicateHeaders: string[] = [];
  for (const h of headers) {
    const key = (h || "").toLowerCase().trim();
    if (!key) continue;
    seenHdr.set(key, (seenHdr.get(key) ?? 0) + 1);
  }
  for (const [k, n] of seenHdr) if (n > 1) duplicateHeaders.push(k);

  const mappedCanon = new Set(
    Object.values(mapping).filter((v): v is string => !!v),
  );
  const unmappedRequired = required.filter((f) => !mappedCanon.has(f));

  const issues: RowIssue[] = [];

  // Pick an "id-like" canonical for duplicate detection, and find the source
  // header mapped to it so highlights land on the actual column the user sees.
  const idKey = canonicalAll.find((f) => /(_no$|^bill_no$|^po_no$|^activity$|^item$|^kpi$)/.test(f));
  const idHeader = idKey
    ? (Object.entries(mapping).find(([, canon]) => canon === idKey)?.[0] ?? null)
    : null;

  const rowsWithIssuesSet = new Set<number>();
  // Map id value → first row index seen; used so the original also gets flagged when a dup appears.
  const firstSeenAt = new Map<string, number>();
  const flaggedRows = new Set<number>();

  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    let idVal = "";
    for (let ci = 0; ci < headers.length; ci++) {
      const h = headers[ci];
      if (!h) continue;
      const canon = mapping[h] ?? null;
      const cell = (r[ci] ?? "").toString();
      const val = cell.length > 80 ? cell.slice(0, 77) + "…" : cell;

      if (canon && required.includes(canon) && !cell.trim()) {
        issues.push({ rowIndex: ri, header: h, canonical: canon, value: val, kind: "empty_required", message: `Required "${canon}" is empty` });
        rowsWithIssuesSet.add(ri);
      }
      if (canon === idKey) idVal = cell.trim();
      if (canon && cell.trim()) {
        if (DATE_FIELDS.test(canon) && !isDateish(cell)) {
          issues.push({ rowIndex: ri, header: h, canonical: canon, value: val, kind: "bad_date", message: `"${val}" isn't a recognisable date` });
          rowsWithIssuesSet.add(ri);
        } else if (NUMBER_FIELDS.test(canon) && !isNumberish(cell)) {
          issues.push({ rowIndex: ri, header: h, canonical: canon, value: val, kind: "bad_number", message: `"${val}" isn't numeric` });
          rowsWithIssuesSet.add(ri);
        }
      }
    }
    if (idKey && idHeader && idVal) {
      const k = idVal.toLowerCase();
      const firstRow = firstSeenAt.get(k);
      if (firstRow === undefined) {
        firstSeenAt.set(k, ri);
      } else {
        // Flag the original once, and every dup row.
        if (!flaggedRows.has(firstRow)) {
          issues.push({ rowIndex: firstRow, header: idHeader, canonical: idKey, value: idVal, kind: "duplicate_key", message: `Duplicate ${idKey} "${idVal}" (first occurrence)` });
          rowsWithIssuesSet.add(firstRow);
          flaggedRows.add(firstRow);
        }
        issues.push({ rowIndex: ri, header: idHeader, canonical: idKey, value: idVal, kind: "duplicate_key", message: `Duplicate ${idKey} "${idVal}"` });
        rowsWithIssuesSet.add(ri);
        flaggedRows.add(ri);
      }
    }
    if (issues.length >= 500) break;
  }

  return {
    totalRows: rows.length,
    rowsWithIssues: rowsWithIssuesSet.size,
    issues,
    unmappedRequired,
    duplicateHeaders,
    emptyHeaders,
  };
}
