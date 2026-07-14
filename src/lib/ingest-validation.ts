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
  kind: "empty_required" | "bad_date" | "bad_number" | "duplicate_key";
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

function isDateish(s: string): boolean {
  if (!s.trim()) return true; // empty allowed here; empty_required is separate
  if (/^\d{5}(\.\d+)?$/.test(s.trim())) return true; // excel serial
  if (!Number.isNaN(Date.parse(s))) return true;
  if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(s.trim())) return true;
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
  const dupKeys = new Set<string>();
  const seenKeys = new Set<string>();

  // Pick an "id-like" canonical for duplicate detection.
  const idKey = canonicalAll.find((f) => /(_no$|^bill_no$|^po_no$|^activity$|^item$|^kpi$)/.test(f));

  const rowsWithIssuesSet = new Set<number>();

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
    if (idKey && idVal) {
      const k = idVal.toLowerCase();
      if (seenKeys.has(k)) {
        if (!dupKeys.has(k)) {
          issues.push({ rowIndex: ri, header: idKey, canonical: idKey, value: idVal, kind: "duplicate_key", message: `Duplicate ${idKey} "${idVal}"` });
          dupKeys.add(k);
          rowsWithIssuesSet.add(ri);
        }
      } else seenKeys.add(k);
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
