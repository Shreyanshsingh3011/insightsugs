import { isTerminalRow, statusBucketForRow } from "./status-utils";

type Severity = "info" | "warning" | "critical";

export type AutoInsight = {
  title: string;
  detail: string;
  severity: Severity;
};

type StoredSheetRow = {
  row_index: number;
  canonical?: unknown;
  extras?: unknown;
  data?: Record<string, unknown>;
};

type DocumentChunk = {
  content: string | null;
  page_no: number | null;
};

function mergeStoredRow(row: StoredSheetRow): Record<string, unknown> {
  if (row.data) return row.data;
  return {
    ...(((row.canonical as Record<string, unknown>) ?? {})),
    ...(((row.extras as Record<string, unknown>) ?? {})),
  };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cellText(value).replace(/[,₹$€£%()\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

function valueCounts(rows: Record<string, unknown>[], column: string) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = cellText(row[column]) || "(blank)";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
}

function chooseCategoricalColumn(rows: Record<string, unknown>[], columns: string[]) {
  const preferred = columns.find((c) => /status|stage|state|priority|severity|progress|owner|project|activity|task|type/i.test(c));
  if (preferred) return preferred;
  return columns.find((c) => {
    const distinct = new Set(rows.map((r) => cellText(r[c])).filter(Boolean)).size;
    return distinct >= 2 && distinct <= Math.max(20, Math.ceil(rows.length * 0.35));
  });
}

function chooseNumericColumn(rows: Record<string, unknown>[], columns: string[]) {
  const candidates = columns
    .map((column) => ({
      column,
      values: rows.map((r) => parseNumber(r[column])).filter((v): v is number => v != null),
    }))
    .filter((c) => c.values.length >= Math.max(2, Math.min(5, Math.ceil(rows.length * 0.1))));
  return (
    candidates.find((c) => /delay|days|amount|total|qty|quantity|cost|value|score|due|balance|paid|rate|percent/i.test(c.column)) ??
    candidates[0]
  );
}

function addInsight(out: AutoInsight[], title: string, detail: string, severity: Severity = "info") {
  if (out.length >= 7) return;
  out.push({ title: title.slice(0, 100), detail: detail.slice(0, 400), severity });
}

function parseDateMs(value: unknown): number | null {
  const s = cellText(value);
  if (!s) return null;
  // dd/mm/yyyy or dd-mm-yyyy
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const [_, d, m, y] = dmy;
    const yr = y.length === 2 ? 2000 + Number(y) : Number(y);
    const t = Date.UTC(yr, Number(m) - 1, Number(d));
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function buildSheetAutoInsights(sheetName: string, storedRows: StoredSheetRow[]) {
  const allRows = storedRows.map(mergeStoredRow).filter((row) => Object.keys(row).length > 0);
  // status-utils imported at top of file.
  const activeRows = allRows.filter((r) => !isTerminalRow(r));
  const columns = Array.from(allRows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));

  const insights: AutoInsight[] = [];
  const questions: string[] = [];

  if (allRows.length === 0) {
    return {
      insights: [
        {
          title: "No rows found",
          detail: `${sheetName} is selected, but no synced rows are currently available for analysis.`,
          severity: "warning" as const,
        },
      ],
      questions: [`Has ${sheetName} synced rows from the source sheet?`],
    };
  }

  // Status breakdown — only surface when it reflects real workload.
  const buckets: Record<string, number> = {};
  for (const r of allRows) {
    const b = statusBucketForRow(r);
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  const pending = (buckets["In Progress"] ?? 0) + (buckets["Not Started"] ?? 0) + (buckets["Delayed"] ?? 0);
  const done = buckets["Completed"] ?? 0;
  const delayed = buckets["Delayed"] ?? 0;

  if (pending > 0 || done > 0 || delayed > 0) {
    const bucketSummary = Object.entries(buckets)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${fmt(v)}`)
      .join(", ");
    addInsight(
      insights,
      "Progress snapshot",
      `${fmt(allRows.length)} rows — ${bucketSummary}. ${fmt(pending)} still open vs ${fmt(done)} completed.`,
      delayed > 0 ? "warning" : "info",
    );
  }

  if (delayed > 0) {
    addInsight(
      insights,
      "Delayed items need attention",
      `${fmt(delayed)} rows are marked delayed / overdue in ${sheetName}.`,
      "critical",
    );
    questions.push(`Which rows in ${sheetName} are currently delayed and why?`);
  }

  // Overdue vs today for any date-like column (only active rows).
  const dateCols = columns.filter((c) => /date|deadline|target|planned|due|expire|expiry/i.test(c));
  const today = Date.now();
  for (const col of dateCols.slice(0, 2)) {
    let overdue = 0;
    let upcoming = 0;
    const overdueExamples: string[] = [];
    const upcomingExamples: string[] = [];
    for (const r of activeRows) {
      const t = parseDateMs(r[col]);
      if (t == null) continue;
      if (t < today) {
        overdue += 1;
        if (overdueExamples.length < 3) overdueExamples.push(new Date(t).toISOString().slice(0, 10));
      } else if (t - today < 14 * 86400_000) {
        upcoming += 1;
        if (upcomingExamples.length < 3) upcomingExamples.push(new Date(t).toISOString().slice(0, 10));
      }
    }
    if (overdue > 0) {
      addInsight(
        insights,
        `Overdue by ${col}`,
        `${fmt(overdue)} active rows have a ${col} in the past${overdueExamples.length ? ` — e.g. ${overdueExamples.join(", ")}` : ""}.`,
        "critical",
      );
      questions.push(`List active rows with ${col} in the past in ${sheetName}.`);
    }
    if (upcoming > 0) {
      addInsight(
        insights,
        `Due within 14 days (${col})`,
        `${fmt(upcoming)} active rows have ${col} within the next 2 weeks${upcomingExamples.length ? ` — e.g. ${upcomingExamples.join(", ")}` : ""}.`,
        "warning",
      );
    }
  }

  // Concentration on a categorical column (active only, so it reflects real workload).
  const catBase = activeRows.length ? activeRows : allRows;
  const catColumn = chooseCategoricalColumn(catBase, columns);
  if (catColumn) {
    const top = valueCounts(catBase, catColumn).filter((v) => v.value !== "(blank)").slice(0, 5);
    if (top.length > 0 && top[0].count > 1) {
      const summary = top.map((v) => `${v.value}: ${fmt(v.count)}`).join(", ");
      const hasRisk = top.some((v) => /pending|delay|delayed|open|hold|blocked|risk|not started/i.test(v.value));
      addInsight(
        insights,
        `Top ${catColumn}`,
        `${catColumn} on ${activeRows.length ? "active" : "all"} rows is concentrated in ${summary}.`,
        hasRisk ? "warning" : "info",
      );
      if (top[0]) questions.push(`Which rows are ${top[0].value} under ${catColumn}?`);
    }
  }

  // Owner / assignee workload if such a column exists.
  const ownerColumn = columns.find((c) => /owner|assignee|responsible|assigned|person|engineer|contractor|vendor/i.test(c));
  if (ownerColumn && activeRows.length > 0) {
    const counts = valueCounts(activeRows, ownerColumn).filter((v) => v.value !== "(blank)").slice(0, 3);
    if (counts.length > 0 && counts[0].count > 0) {
      addInsight(
        insights,
        `Workload by ${ownerColumn}`,
        `Highest open workload: ${counts.map((c) => `${c.value} (${fmt(c.count)})`).join(", ")}.`,
      );
      questions.push(`What is open with ${counts[0].value} in ${sheetName}?`);
    }
  }

  // Only surface numeric findings when they are meaningful (cost/amount/qty)
  // and the spread is actually notable — skip generic avg/min/max noise.
  const numeric = chooseNumericColumn(allRows, columns);
  if (numeric && /amount|cost|price|budget|value|total|qty|quantity|units|kw|mw|capacity/i.test(numeric.column)) {
    const values = numeric.values;
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const max = Math.max(...values);
    if (values.length >= 3 && max > avg * 3) {
      addInsight(
        insights,
        `${numeric.column} outliers`,
        `${fmt(values.length)} values in ${numeric.column} — total ${fmt(sum)}, with a max of ${fmt(max)} well above the average (${fmt(avg)}).`,
        "warning",
      );
      questions.push(`Show the top rows by ${numeric.column} in ${sheetName}.`);
    }
  }

  // Only report data gaps if they cover a meaningful share of the sheet.
  const gapStats = columns
    .map((column) => ({ column, blanks: allRows.filter((r) => !cellText(r[column])).length }))
    .filter((g) => g.blanks >= Math.max(3, allRows.length * 0.2) && g.blanks < allRows.length)
    .sort((a, b) => b.blanks - a.blanks)
    .slice(0, 2);
  if (gapStats.length > 0) {
    addInsight(
      insights,
      "Data gaps",
      `Largest blank areas: ${gapStats.map((g) => `${g.column} (${fmt(g.blanks)} blanks / ${fmt(allRows.length)} rows)`).join(", ")}.`,
      "warning",
    );
    questions.push(`Which rows have missing ${gapStats[0].column}?`);
  }


  // Sheet-shape templates: append tailored insights based on detected columns.
  applySheetTemplates({ sheetName, allRows, activeRows, columns, insights, questions });

  const labelColumn = columns.find((c) => /project|activity|task|name|item|code|vendor|client/i.test(c));
  if (labelColumn) {
    const examples = activeRows.map((r) => cellText(r[labelColumn])).filter(Boolean).slice(0, 4).join(", ");
    if (examples) {
      questions.push(`Summarize the row for ${examples.split(",")[0]?.trim()}.`);
    }
  }


  while (questions.length < 4 && columns.length > 0) {
    const column = columns[questions.length % columns.length];
    const q = `What patterns are visible in ${column} for ${sheetName}?`;
    if (!questions.includes(q)) questions.push(q);
    else break;
  }

  return { insights: insights.slice(0, 7), questions: questions.slice(0, 6) };
}


export function buildDocumentAutoInsights(input: {
  name: string;
  summary?: string | null;
  key_points?: unknown;
  page_count?: number | null;
  chunks: DocumentChunk[];
}) {
  const insights: AutoInsight[] = [];
  const questions: string[] = [];
  const keyPoints = Array.isArray(input.key_points) ? input.key_points.map((p) => cellText(p)).filter(Boolean) : [];
  const snippets = input.chunks.map((c) => cellText(c.content)).filter(Boolean);

  addInsight(
    insights,
    "Document coverage",
    `${input.name} has ${fmt(input.page_count ?? 0)} pages and ${fmt(input.chunks.length)} indexed text chunks available.`,
  );

  if (input.summary) {
    addInsight(insights, "Summary available", input.summary);
    questions.push(`What are the main obligations in ${input.name}?`);
  }

  for (const point of keyPoints.slice(0, 4)) {
    addInsight(insights, point.slice(0, 60) || "Key point", point);
    questions.push(`Explain: ${point.slice(0, 80)}?`);
  }

  for (const chunk of snippets.slice(0, 5)) {
    if (insights.length >= 5) break;
    const sentence = chunk.split(/(?<=[.!?])\s+/).find((s) => s.trim().length > 40) ?? chunk;
    addInsight(insights, "Indexed excerpt", sentence.slice(0, 280));
  }

  if (insights.length === 1) {
    addInsight(insights, "No extracted text", "The document exists, but no detailed extracted text is available for richer findings.", "warning");
  }

  while (questions.length < 4) {
    questions.push([
      `Summarize ${input.name} by section.`,
      `List dates, deadlines, or milestones in ${input.name}.`,
      `Find risks or missing obligations in ${input.name}.`,
      `Who are the named parties or owners in ${input.name}?`,
    ][questions.length]);
  }

  return { insights: insights.slice(0, 7), questions: questions.slice(0, 6) };
}

// ---------- Sheet-shape templates ----------

type TemplateCtx = {
  sheetName: string;
  allRows: Record<string, unknown>[];
  activeRows: Record<string, unknown>[];
  columns: string[];
  insights: AutoInsight[];
  questions: string[];
};

function findCol(columns: string[], re: RegExp): string | undefined {
  return columns.find((c) => re.test(c));
}

function sumCol(rows: Record<string, unknown>[], col: string): { sum: number; count: number } {
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    const n = parseNumber(r[col]);
    if (n != null) { sum += n; count += 1; }
  }
  return { sum, count };
}

function topByGroup(rows: Record<string, unknown>[], groupCol: string, valueCol: string, limit = 3) {
  const acc = new Map<string, number>();
  for (const r of rows) {
    const key = cellText(r[groupCol]) || "(blank)";
    const n = parseNumber(r[valueCol]);
    if (n == null) continue;
    acc.set(key, (acc.get(key) ?? 0) + n);
  }
  return Array.from(acc.entries())
    .filter(([k]) => k !== "(blank)")
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

type SheetShape = "payments" | "hr_attendance" | "contacts" | "inventory" | "contracts" | "timeline" | "sales_crm" | "tickets" | "generic";

export function detectSheetShape(columns: string[]): SheetShape {
  const cols = columns.join("|").toLowerCase();
  if (/invoice|payment|paid|due amount|outstanding|receivable|payable|bill|po number|purchase order/.test(cols)) return "payments";
  if (/attendance|check[- ]?in|check[- ]?out|shift|leave|absent|present|hours worked|payroll/.test(cols)) return "hr_attendance";
  if (/email|phone|mobile|contact|address|city|pincode|zip/.test(cols) && !/status|stage|progress/.test(cols)) return "contacts";
  if (/stock|inventory|sku|units in|on hand|qty on|reorder|warehouse/.test(cols)) return "inventory";
  if (/contract|agreement|expiry|expires|renewal|clause|nda|mou/.test(cols)) return "contracts";
  if (/milestone|phase|planned|actual|baseline|start date|end date|target date|completion/.test(cols)) return "timeline";
  if (/lead|opportunity|deal|pipeline|prospect|conversion|revenue|customer/.test(cols)) return "sales_crm";
  if (/ticket|complaint|issue|resolution|sla|priority|reported/.test(cols)) return "tickets";
  return "generic";
}

function applySheetTemplates(ctx: TemplateCtx) {
  const shape = detectSheetShape(ctx.columns);
  switch (shape) {
    case "payments": return templatePayments(ctx);
    case "hr_attendance": return templateHrAttendance(ctx);
    case "contacts": return templateContacts(ctx);
    case "inventory": return templateInventory(ctx);
    case "contracts": return templateContracts(ctx);
    case "timeline": return templateTimeline(ctx);
    case "sales_crm": return templateSalesCrm(ctx);
    case "tickets": return templateTickets(ctx);
    default: return;
  }
}

function templatePayments({ sheetName, allRows, activeRows, columns, insights, questions }: TemplateCtx) {
  const amountCol = findCol(columns, /amount|total|invoice value|gross|net/i);
  const paidCol = findCol(columns, /paid|received|settled/i);
  const dueCol = findCol(columns, /outstanding|balance|due amount|pending amount/i);
  const dueDateCol = findCol(columns, /due date|payment date|invoice date/i);
  const vendorCol = findCol(columns, /vendor|supplier|party|client|customer/i);

  if (amountCol) {
    const { sum, count } = sumCol(allRows, amountCol);
    if (count > 0) addInsight(insights, `Total ${amountCol}`, `${fmt(sum)} across ${fmt(count)} entries in ${sheetName}.`);
  }
  if (dueCol) {
    const { sum, count } = sumCol(allRows, dueCol);
    if (sum > 0) {
      addInsight(insights, `Outstanding ${dueCol}`, `${fmt(sum)} still unpaid across ${fmt(count)} rows.`, "critical");
      questions.push(`Which rows have the largest ${dueCol}?`);
    }
  }
  if (paidCol && amountCol) {
    const paid = sumCol(allRows, paidCol).sum;
    const total = sumCol(allRows, amountCol).sum;
    if (total > 0) {
      const pct = (paid / total) * 100;
      addInsight(insights, "Collection rate", `${fmt(pct)}% collected (${fmt(paid)} of ${fmt(total)}).`, pct < 60 ? "warning" : "info");
    }
  }
  if (vendorCol && (dueCol || amountCol)) {
    const valueCol = dueCol ?? amountCol!;
    const top = topByGroup(allRows, vendorCol, valueCol);
    if (top.length) {
      addInsight(insights, `Top ${vendorCol} by ${valueCol}`, top.map(([k, v]) => `${k} (${fmt(v)})`).join(", "));
      questions.push(`Break down ${valueCol} by ${vendorCol}.`);
    }
  }
  if (dueDateCol) {
    const today = Date.now();
    let overdue = 0;
    for (const r of activeRows) {
      const t = parseDateMs(r[dueDateCol]);
      if (t != null && t < today) overdue += 1;
    }
    if (overdue > 0) addInsight(insights, `Overdue ${dueDateCol}`, `${fmt(overdue)} rows are past their ${dueDateCol}.`, "critical");
  }
}

function templateHrAttendance({ sheetName, allRows, columns, insights, questions }: TemplateCtx) {
  const personCol = findCol(columns, /name|employee|staff|person/i);
  const statusCol = findCol(columns, /status|attendance|present|absent|leave/i);
  const hoursCol = findCol(columns, /hours|worked|duration|shift/i);
  const dateCol = findCol(columns, /date|day/i);

  if (statusCol) {
    const counts = valueCounts(allRows, statusCol).filter((v) => v.value !== "(blank)").slice(0, 5);
    if (counts.length) addInsight(insights, `Attendance mix — ${statusCol}`, counts.map((c) => `${c.value}: ${fmt(c.count)}`).join(", "));
    const absent = counts.find((c) => /absent|leave/i.test(c.value));
    if (absent && absent.count > 0) addInsight(insights, "Absences logged", `${fmt(absent.count)} absent/leave entries in ${sheetName}.`, "warning");
  }
  if (personCol && statusCol) {
    const abs = new Map<string, number>();
    for (const r of allRows) {
      if (/absent|leave/i.test(cellText(r[statusCol]))) {
        const k = cellText(r[personCol]) || "(unknown)";
        abs.set(k, (abs.get(k) ?? 0) + 1);
      }
    }
    const top = Array.from(abs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top.length) {
      addInsight(insights, "Most absences", top.map(([k, v]) => `${k} (${fmt(v)})`).join(", "), "warning");
      questions.push(`Why is ${top[0][0]} absent most often?`);
    }
  }
  if (hoursCol) {
    const { sum, count } = sumCol(allRows, hoursCol);
    if (count > 0) addInsight(insights, `Total ${hoursCol}`, `${fmt(sum)} across ${fmt(count)} entries (avg ${fmt(sum / count)}).`);
  }
  if (dateCol) questions.push(`What is the attendance trend by ${dateCol}?`);
}

function templateContacts({ sheetName, allRows, columns, insights, questions }: TemplateCtx) {
  const emailCol = findCol(columns, /email/i);
  const phoneCol = findCol(columns, /phone|mobile|contact number/i);
  const cityCol = findCol(columns, /city|location|region|state/i);
  const nameCol = findCol(columns, /name/i);

  addInsight(insights, "Contact directory", `${fmt(allRows.length)} contacts on file in ${sheetName}.`);

  if (emailCol) {
    const withEmail = allRows.filter((r) => /@/.test(cellText(r[emailCol]))).length;
    const missing = allRows.length - withEmail;
    addInsight(insights, "Email coverage", `${fmt(withEmail)} of ${fmt(allRows.length)} have an email${missing > 0 ? ` — ${fmt(missing)} missing` : ""}.`, missing > allRows.length * 0.2 ? "warning" : "info");
  }
  if (phoneCol) {
    const withPhone = allRows.filter((r) => cellText(r[phoneCol]).replace(/\D/g, "").length >= 7).length;
    addInsight(insights, "Phone coverage", `${fmt(withPhone)} of ${fmt(allRows.length)} have a usable phone number.`, withPhone < allRows.length * 0.8 ? "warning" : "info");
  }
  if (cityCol) {
    const top = valueCounts(allRows, cityCol).filter((v) => v.value !== "(blank)").slice(0, 5);
    if (top.length) addInsight(insights, `Top ${cityCol}`, top.map((v) => `${v.value} (${fmt(v.count)})`).join(", "));
  }
  if (nameCol) {
    const dupes = valueCounts(allRows, nameCol).filter((v) => v.value !== "(blank)" && v.count > 1);
    if (dupes.length) addInsight(insights, "Possible duplicates", `${fmt(dupes.length)} names appear more than once — e.g. ${dupes.slice(0, 3).map((d) => `${d.value} (${d.count})`).join(", ")}.`, "warning");
    questions.push(`Show the full record for ${cellText(allRows[0]?.[nameCol])}.`);
  }
}

function templateInventory({ sheetName, allRows, columns, insights, questions }: TemplateCtx) {
  const qtyCol = findCol(columns, /qty|quantity|on hand|stock|units/i);
  const reorderCol = findCol(columns, /reorder|min stock|threshold/i);
  const skuCol = findCol(columns, /sku|item code|product/i);
  const warehouseCol = findCol(columns, /warehouse|location|bin/i);

  if (qtyCol) {
    const { sum, count } = sumCol(allRows, qtyCol);
    addInsight(insights, `Total ${qtyCol}`, `${fmt(sum)} units across ${fmt(count)} SKUs in ${sheetName}.`);
    const zero = allRows.filter((r) => parseNumber(r[qtyCol]) === 0).length;
    if (zero > 0) addInsight(insights, "Out of stock", `${fmt(zero)} rows show 0 ${qtyCol}.`, "critical");
  }
  if (qtyCol && reorderCol) {
    const below = allRows.filter((r) => {
      const q = parseNumber(r[qtyCol]);
      const min = parseNumber(r[reorderCol]);
      return q != null && min != null && q < min;
    }).length;
    if (below > 0) addInsight(insights, "Below reorder level", `${fmt(below)} SKUs are under their ${reorderCol}.`, "critical");
  }
  if (warehouseCol && qtyCol) {
    const top = topByGroup(allRows, warehouseCol, qtyCol);
    if (top.length) addInsight(insights, `Stock by ${warehouseCol}`, top.map(([k, v]) => `${k} (${fmt(v)})`).join(", "));
  }
  if (skuCol) questions.push(`What is the current stock for ${cellText(allRows[0]?.[skuCol])}?`);
}

function templateContracts({ sheetName, allRows, activeRows, columns, insights, questions }: TemplateCtx) {
  const expiryCol = findCol(columns, /expiry|expires|end date|renewal/i);
  const partyCol = findCol(columns, /party|counterparty|vendor|client|customer/i);
  const valueCol = findCol(columns, /value|amount|worth/i);

  if (expiryCol) {
    const today = Date.now();
    let expired = 0;
    let soon = 0;
    for (const r of activeRows) {
      const t = parseDateMs(r[expiryCol]);
      if (t == null) continue;
      if (t < today) expired += 1;
      else if (t - today < 60 * 86400_000) soon += 1;
    }
    if (expired > 0) addInsight(insights, `Expired contracts`, `${fmt(expired)} rows have ${expiryCol} in the past.`, "critical");
    if (soon > 0) addInsight(insights, `Renewals within 60 days`, `${fmt(soon)} contracts expire within 2 months.`, "warning");
  }
  if (partyCol) {
    const top = valueCounts(activeRows.length ? activeRows : allRows, partyCol).filter((v) => v.value !== "(blank)").slice(0, 3);
    if (top.length) addInsight(insights, `Top ${partyCol}`, top.map((v) => `${v.value} (${fmt(v.count)})`).join(", "));
  }
  if (valueCol) {
    const { sum, count } = sumCol(allRows, valueCol);
    if (count > 0) addInsight(insights, `Contract portfolio ${valueCol}`, `${fmt(sum)} across ${fmt(count)} contracts.`);
  }
  questions.push(`Which contracts expire in the next 30 days in ${sheetName}?`);
}

function templateTimeline({ sheetName, activeRows, columns, insights, questions }: TemplateCtx) {
  const startCol = findCol(columns, /start date|planned start|baseline start/i);
  const endCol = findCol(columns, /end date|target date|planned end|completion|due date/i);
  const actualCol = findCol(columns, /actual|actual end|actual completion/i);
  const milestoneCol = findCol(columns, /milestone|phase|activity|task/i);

  if (endCol) {
    const today = Date.now();
    let overdue = 0;
    let next: { name: string; date: string } | null = null;
    let soonest = Infinity;
    for (const r of activeRows) {
      const t = parseDateMs(r[endCol]);
      if (t == null) continue;
      if (t < today) overdue += 1;
      else if (t < soonest) {
        soonest = t;
        next = { name: cellText(r[milestoneCol ?? ""]) || "next item", date: new Date(t).toISOString().slice(0, 10) };
      }
    }
    if (overdue > 0) addInsight(insights, `Overdue by ${endCol}`, `${fmt(overdue)} active items past their ${endCol}.`, "critical");
    if (next) addInsight(insights, "Next milestone", `${next.name} due ${next.date}.`, "info");
  }
  if (startCol && endCol) {
    const durations: number[] = [];
    for (const r of activeRows) {
      const s = parseDateMs(r[startCol]);
      const e = parseDateMs(r[endCol]);
      if (s != null && e != null && e > s) durations.push((e - s) / 86400_000);
    }
    if (durations.length) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      addInsight(insights, "Planned duration", `Average planned span ${fmt(avg)} days across ${fmt(durations.length)} items.`);
    }
  }
  if (endCol && actualCol) {
    const slips: number[] = [];
    for (const r of activeRows) {
      const e = parseDateMs(r[endCol]);
      const a = parseDateMs(r[actualCol]);
      if (e != null && a != null) slips.push((a - e) / 86400_000);
    }
    const late = slips.filter((s) => s > 0);
    if (late.length) addInsight(insights, "Schedule slippage", `${fmt(late.length)} items finished late by an average of ${fmt(late.reduce((a, b) => a + b, 0) / late.length)} days.`, "warning");
  }
  questions.push(`What's on the critical path for ${sheetName}?`);
}

function templateSalesCrm({ sheetName, allRows, activeRows, columns, insights, questions }: TemplateCtx) {
  const stageCol = findCol(columns, /stage|status|pipeline/i);
  const valueCol = findCol(columns, /value|amount|revenue|deal size/i);
  const ownerCol = findCol(columns, /owner|rep|sales|assigned/i);
  const closeCol = findCol(columns, /close date|expected close/i);

  if (stageCol) {
    const counts = valueCounts(activeRows, stageCol).filter((v) => v.value !== "(blank)").slice(0, 5);
    if (counts.length) addInsight(insights, `Pipeline by ${stageCol}`, counts.map((c) => `${c.value}: ${fmt(c.count)}`).join(", "));
    const won = counts.find((c) => /won|closed[- ]won/i.test(c.value));
    const lost = counts.find((c) => /lost|closed[- ]lost/i.test(c.value));
    if (won && lost) {
      const rate = won.count / (won.count + lost.count) * 100;
      addInsight(insights, "Win rate", `${fmt(rate)}% (${fmt(won.count)} won / ${fmt(lost.count)} lost).`, rate < 40 ? "warning" : "info");
    }
  }
  if (valueCol) {
    const openRows = activeRows.length ? activeRows : allRows;
    const { sum } = sumCol(openRows, valueCol);
    if (sum > 0) addInsight(insights, `Open ${valueCol}`, `${fmt(sum)} in open pipeline across ${fmt(openRows.length)} deals.`);
  }
  if (ownerCol && valueCol) {
    const top = topByGroup(activeRows, ownerCol, valueCol);
    if (top.length) addInsight(insights, `Top ${ownerCol} by ${valueCol}`, top.map(([k, v]) => `${k} (${fmt(v)})`).join(", "));
  }
  if (closeCol) questions.push(`Which deals are expected to close in the next 30 days in ${sheetName}?`);
}

function templateTickets({ sheetName, allRows, activeRows, columns, insights, questions }: TemplateCtx) {
  const priorityCol = findCol(columns, /priority|severity/i);
  const statusCol = findCol(columns, /status|state|resolution/i);
  const slaCol = findCol(columns, /sla|breach/i);
  const assigneeCol = findCol(columns, /assignee|owner|assigned/i);
  const reportedCol = findCol(columns, /reported|created|opened/i);

  if (priorityCol) {
    const counts = valueCounts(activeRows, priorityCol).filter((v) => v.value !== "(blank)").slice(0, 5);
    if (counts.length) addInsight(insights, `Open by ${priorityCol}`, counts.map((c) => `${c.value}: ${fmt(c.count)}`).join(", "));
    const high = counts.find((c) => /high|critical|p0|p1|urgent/i.test(c.value));
    if (high && high.count > 0) addInsight(insights, "High priority open", `${fmt(high.count)} open ${high.value} tickets.`, "critical");
  }
  if (statusCol) {
    const open = activeRows.length;
    const closed = allRows.length - open;
    if (open + closed > 0) addInsight(insights, "Ticket load", `${fmt(open)} open vs ${fmt(closed)} closed in ${sheetName}.`);
  }
  if (slaCol) {
    const breached = allRows.filter((r) => /breach|missed|violated|true|yes/i.test(cellText(r[slaCol]))).length;
    if (breached > 0) addInsight(insights, "SLA breaches", `${fmt(breached)} tickets have breached ${slaCol}.`, "critical");
  }
  if (assigneeCol) {
    const top = valueCounts(activeRows, assigneeCol).filter((v) => v.value !== "(blank)").slice(0, 3);
    if (top.length) addInsight(insights, `Open workload — ${assigneeCol}`, top.map((v) => `${v.value} (${fmt(v.count)})`).join(", "));
  }
  if (reportedCol) {
    const today = Date.now();
    const aging = activeRows.filter((r) => {
      const t = parseDateMs(r[reportedCol]);
      return t != null && (today - t) > 7 * 86400_000;
    }).length;
    if (aging > 0) addInsight(insights, "Aging tickets (>7d)", `${fmt(aging)} open tickets have been open more than a week.`, "warning");
  }
  questions.push(`Which tickets breached SLA in ${sheetName}?`);
}
