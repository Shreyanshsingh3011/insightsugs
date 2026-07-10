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