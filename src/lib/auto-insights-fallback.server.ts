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

export function buildSheetAutoInsights(sheetName: string, storedRows: StoredSheetRow[]) {
  const rows = storedRows.map(mergeStoredRow).filter((row) => Object.keys(row).length > 0);
  const columns = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set<string>()));

  const insights: AutoInsight[] = [];
  const questions: string[] = [];

  if (rows.length === 0) {
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

  addInsight(
    insights,
    "Sheet coverage",
    `${sheetName} currently has ${fmt(rows.length)} synced rows across ${fmt(columns.length)} columns.`,
  );

  const catColumn = chooseCategoricalColumn(rows, columns);
  if (catColumn) {
    const top = valueCounts(rows, catColumn).slice(0, 5);
    const summary = top.map((v) => `${v.value}: ${fmt(v.count)}`).join(", ");
    const hasRisk = top.some((v) => /pending|delay|delayed|open|hold|blocked|risk|not started/i.test(v.value));
    addInsight(insights, `Top ${catColumn} values`, `${catColumn} is concentrated around ${summary}.`, hasRisk ? "warning" : "info");
    questions.push(`Which rows are currently ${top[0]?.value} in ${catColumn}?`);
  }

  const numeric = chooseNumericColumn(rows, columns);
  if (numeric) {
    const values = numeric.values;
    const sum = values.reduce((a, b) => a + b, 0);
    addInsight(
      insights,
      `${numeric.column} range`,
      `${numeric.column} has ${fmt(values.length)} numeric values: sum ${fmt(sum)}, average ${fmt(sum / values.length)}, min ${fmt(Math.min(...values))}, max ${fmt(Math.max(...values))}.`,
    );
    questions.push(`Show the top rows by ${numeric.column} in ${sheetName}.`);
  }

  const dateColumn = columns.find((c) => /date|deadline|target|planned|due/i.test(c));
  if (dateColumn) {
    const filled = rows.filter((r) => cellText(r[dateColumn])).length;
    addInsight(insights, `${dateColumn} coverage`, `${dateColumn} is filled on ${fmt(filled)} of ${fmt(rows.length)} rows.`, filled < rows.length ? "warning" : "info");
    questions.push(`Which ${dateColumn} entries are earliest or overdue?`);
  }

  const gapStats = columns
    .map((column) => ({ column, blanks: rows.filter((r) => !cellText(r[column])).length }))
    .filter((g) => g.blanks > 0)
    .sort((a, b) => b.blanks - a.blanks)
    .slice(0, 3);
  if (gapStats.length > 0) {
    addInsight(
      insights,
      "Data gaps",
      `The largest blank areas are ${gapStats.map((g) => `${g.column} (${fmt(g.blanks)} blanks)`).join(", ")}.`,
      "warning",
    );
    questions.push(`Which rows have missing ${gapStats[0].column}?`);
  }

  const labelColumn = columns.find((c) => /project|activity|task|name|item|code|vendor|client/i.test(c));
  if (labelColumn) {
    const examples = rows.map((r) => cellText(r[labelColumn])).filter(Boolean).slice(0, 5).join(", ");
    if (examples) {
      addInsight(insights, `${labelColumn} examples`, `Representative ${labelColumn} values include ${examples}.`);
      questions.push(`Summarize the rows for ${examples.split(",")[0]?.trim() || labelColumn}.`);
    }
  }

  while (questions.length < 4 && columns.length > questions.length) {
    const column = columns[questions.length % columns.length];
    questions.push(`What patterns are visible in ${column} for ${sheetName}?`);
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