// Classify + parse a question into either a deterministic aggregation or a qualitative request.
import type { SheetSource, ParsedAgg, FilterSpec } from "./compute";
import { matchColumn, normKey } from "./compute";

const Q_INTENT = /\b(how\s+many|how\s+much|count|number\s+of|total|sum|average|avg|mean|median|max(?:imum)?|min(?:imum)?|highest|lowest|most|least|largest|smallest|top|bottom|per\s+\w+|group\s+by|percent|percentage|%\s*of|compare)\b/i;

export function classify(q: string): "quantitative" | "qualitative" {
  return Q_INTENT.test(q) ? "quantitative" : "qualitative";
}

// Try to parse a quantitative intent. Returns null if we can't confidently produce one.
export function parseQuestion(q: string, sheets: SheetSource[]): ParsedAgg | null {
  if (sheets.length === 0) return null;
  const lower = q.toLowerCase();

  // "which X has the most/least Y" or "which X has the most items/rows"
  const whichMost = /\bwhich\s+([\w ]+?)\s+(?:has|have)\s+(?:the\s+)?(most|least|highest|lowest|fewest)(?:\s+(?:number\s+of\s+|count\s+of\s+|line\s+items?|items?|rows?))?/i.exec(q);
  if (whichMost) {
    const grpToken = whichMost[1].trim();
    const dir = whichMost[2].toLowerCase();
    const col = matchColumn(sheets, grpToken);
    if (col) {
      return {
        kind: dir.startsWith("least") || dir.startsWith("low") || dir.startsWith("few") ? "argminCount" : "argmaxCount",
        groupBy: col.column,
        sheet: col.sheet.label,
      };
    }
  }

  // "per X" / "by X" / "for each X" — group by
  const perBy = /\b(?:per|by|for each|group(?:ed)?\s+by)\s+([\w ]+?)(?:[\?\.,]|$)/i.exec(q);

  // Aggregation keywords
  let kind: "sum" | "avg" | "min" | "max" | "count" | null = null;
  if (/\b(total|sum)\b/i.test(lower)) kind = "sum";
  else if (/\b(average|avg|mean)\b/i.test(lower)) kind = "avg";
  else if (/\b(max|maximum|highest|largest|top)\b/i.test(lower)) kind = "max";
  else if (/\b(min|minimum|lowest|smallest|bottom)\b/i.test(lower)) kind = "min";
  else if (/\b(how\s+many|count|number\s+of)\b/i.test(lower)) kind = "count";

  if (!kind) return null;

  // Optional filter: "in <sheet>" / "for <value>"
  let sheet: string | undefined;
  const inSheet = /\bin\s+([\w][\w \-]{1,40})/i.exec(q);
  if (inSheet) {
    const candidate = inSheet[1].trim();
    const s = sheets.find((sh) => normKey(sh.label).includes(normKey(candidate)) || normKey(candidate).includes(normKey(sh.label)));
    if (s) sheet = s.label;
  }

  // Filter "where X is Y" or "with X = Y" or quoted value
  let filter: FilterSpec | undefined;
  const quoted = /["']([^"']{2,60})["']/.exec(q);
  if (quoted) {
    const val = quoted[1].toLowerCase();
    // Find column containing that value across all rows
    const candidate = findColumnContaining(sheets, val);
    if (candidate) filter = { column: candidate, equalsLower: val };
  }
  const eqMatch = /\b(?:where|with|for)\s+([\w ]+?)\s*(?:=|is|in|equals?)\s*([\w \-\.]+?)(?:[\?\.,]|$)/i.exec(q);
  if (!filter && eqMatch) {
    const col = matchColumn(sheets, eqMatch[1].trim());
    if (col) filter = { column: col.column, equalsLower: eqMatch[2].trim().toLowerCase() };
  }

  if (perBy) {
    const gb = matchColumn(sheets, perBy[1].trim());
    if (gb) {
      if (kind === "count") return { kind: "groupCount", groupBy: gb.column, sheet: sheet ?? gb.sheet.label };
      if (kind === "sum") {
        // We still need a target column; try to find one earlier in question
        const target = findValueColumn(q, sheets);
        if (target) return { kind: "groupSum", groupBy: gb.column, column: target.column, sheet: sheet ?? gb.sheet.label };
      }
    }
  }

  if (kind === "count") {
    return { kind: "count", sheet, filter };
  }

  // sum/avg/min/max need a column. Look for it in the question.
  const target = findValueColumn(q, sheets);
  if (!target) return null;
  return { kind, column: target.column, sheet: sheet ?? target.sheet.label, filter };
}

function findValueColumn(q: string, sheets: SheetSource[]) {
  // Try to find a column name token in the question
  const tokens = q.replace(/[?\.,]/g, " ").split(/\s+/).filter((t) => t.length > 2);
  let best: { sheet: SheetSource; column: string; score: number } | null = null;
  for (const tok of tokens) {
    const m = matchColumn(sheets, tok);
    if (m) {
      const score = tok.length;
      if (!best || score > best.score) best = { sheet: m.sheet, column: m.column, score };
    }
  }
  // Multi-word column phrases
  for (let i = 0; i < tokens.length - 1; i++) {
    const phrase = `${tokens[i]} ${tokens[i + 1]}`;
    const m = matchColumn(sheets, phrase);
    if (m) {
      const score = phrase.length + 5;
      if (!best || score > best.score) best = { sheet: m.sheet, column: m.column, score };
    }
  }
  return best ? { sheet: best.sheet, column: best.column } : null;
}

function findColumnContaining(sheets: SheetSource[], value: string): string | null {
  for (const s of sheets) {
    for (const c of s.columns) {
      for (const r of s.rows) {
        const v = r[c];
        if (v != null && String(v).toLowerCase().includes(value)) return c;
      }
    }
  }
  return null;
}
