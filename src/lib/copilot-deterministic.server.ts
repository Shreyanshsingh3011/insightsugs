// Deterministic no-LLM answer engine used when the Lovable AI Gateway is
// unavailable (402/quota) AND the Gemini fallback is missing or fails.
// It scans the already-selected sheets/documents and produces a grounded,
// cited answer for the most common question shapes: counts, totals,
// averages, top-N, distributions, keyword lookups, and doc snippet search.
//
// Every returned answer includes `[sheet:Name row N]` or `[doc:Name p.N]`
// citation markers plus a "Sources:" section so it satisfies the same
// citation contract the LLM path uses.

type SheetReg = { id: string; display_name: string };
type DocMeta = { id: string; name: string };

type StoredRow = { row_index: number; data: Record<string, unknown> };
type DocChunk = { document_id: string; page_no: number | null; content: string | null };

export type DeterministicLedgerRow = {
  kind: "sheet_row";
  registryId: string;
  sheetLabel: string;
  rowIndex: number;
  data: Record<string, unknown>;
};
export type DeterministicLedgerDoc = {
  kind: "doc_chunk";
  documentId: string;
  documentName: string;
  pageNo: number;
  snippet: string;
};
export type DeterministicLedgerEntry = DeterministicLedgerRow | DeterministicLedgerDoc;

const TERMINAL = /\b(done|closed|complete|completed|delivered|dispatched|resolved|cancelled|canceled)\b/i;

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim();
}

function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = cellText(v).replace(/[,₹$€£%()\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);
}

function allColumns(rows: StoredRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) set.add(k);
  return Array.from(set);
}

function pickColumn(cols: string[], patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const hit = cols.find((c) => p.test(c));
    if (hit) return hit;
  }
  return null;
}

function pickNumericColumn(rows: StoredRow[], cols: string[], hint?: string | null): { column: string; values: { row: StoredRow; n: number }[] } | null {
  const candidates = cols.map((c) => {
    const values = rows
      .map((r) => ({ row: r, n: parseNum(r.data[c]) }))
      .filter((x): x is { row: StoredRow; n: number } => x.n != null);
    return { column: c, values };
  });
  const usable = candidates.filter((c) => c.values.length >= Math.max(2, Math.ceil(rows.length * 0.1)));
  if (usable.length === 0) return null;
  if (hint) {
    const re = new RegExp(hint, "i");
    const match = usable.find((c) => re.test(c.column));
    if (match) return match;
  }
  const preferred = usable.find((c) => /amount|total|qty|quantity|value|cost|price|score|days|delay|balance|paid/i.test(c.column));
  return preferred ?? usable[0];
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

const STOP = new Set([
  "the","a","an","and","or","of","in","on","for","to","with","is","are","was","were","be","by",
  "how","many","what","which","show","list","give","tell","me","find","get","all","any","from",
  "please","can","you","do","does","did","will","that","this","these","those","some","most","have",
  "has","had","not","no","yes","about","into","over","under","between","across","per","each",
  "count","total","sum","average","avg","mean","min","max","top","bottom","highest","lowest",
  "current","status","project","projects","row","rows","sheet","sheets","doc","docs","document",
  "documents","data","information",
]);

function rowMatchesTokens(row: StoredRow, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = Object.entries(row.data)
    .map(([k, v]) => `${k} ${cellText(v)}`)
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits += 1;
  return hits;
}

function statusColumn(cols: string[]): string | null {
  return pickColumn(cols, [/^status$/i, /status/i, /stage/i, /state/i, /progress/i]);
}

function isTerminal(row: StoredRow, statusCol: string | null): boolean {
  if (!statusCol) return false;
  return TERMINAL.test(cellText(row.data[statusCol]));
}

type Intent =
  | { kind: "count" }
  | { kind: "sum" | "avg" | "min" | "max"; hint: string | null }
  | { kind: "top"; direction: "highest" | "lowest"; hint: string | null; n: number }
  | { kind: "distribution"; hint: string | null }
  | { kind: "list" }
  | { kind: "generic" };

function detectIntent(q: string): Intent {
  const s = q.toLowerCase();
  if (/\b(how\s+many|count|number\s+of|total\s+number)\b/.test(s)) return { kind: "count" };
  const numHint = /(amount|total|value|cost|price|qty|quantity|days|delay|score|balance|paid|revenue|budget)/i.exec(s)?.[1] ?? null;
  if (/\b(sum|total)\b/.test(s) && !/\bnumber\b/.test(s)) return { kind: "sum", hint: numHint };
  if (/\b(average|avg|mean)\b/.test(s)) return { kind: "avg", hint: numHint };
  if (/\b(minimum|min|lowest\s+value|smallest)\b/.test(s)) return { kind: "min", hint: numHint };
  if (/\b(maximum|max|largest|highest\s+value)\b/.test(s)) return { kind: "max", hint: numHint };
  const topMatch = /\b(top|highest|largest|biggest)\s+(\d+)?/.exec(s);
  if (topMatch) return { kind: "top", direction: "highest", hint: numHint, n: Number(topMatch[2] ?? 5) };
  const botMatch = /\b(bottom|lowest|smallest)\s+(\d+)?/.exec(s);
  if (botMatch) return { kind: "top", direction: "lowest", hint: numHint, n: Number(botMatch[2] ?? 5) };
  if (/\b(distribution|breakdown|by\s+\w+|group(ed)?\s+by|per\s+\w+)\b/.test(s)) {
    const groupHint = /(status|stage|state|owner|type|priority|category|project|vendor|activity|region|department)/i.exec(s)?.[1] ?? null;
    return { kind: "distribution", hint: groupHint };
  }
  if (/\b(list|show|display|which|what\s+are|find|give\s+me)\b/.test(s)) return { kind: "list" };
  return { kind: "generic" };
}

// -------------------- main entry --------------------

export async function deterministicAnswer(params: {
  supabase: any;
  question: string;
  regs: SheetReg[];
  docs: DocMeta[];
  maxRowsPerSheet?: number;
  ledgerSink?: DeterministicLedgerEntry[];
}): Promise<{ answer: string; citations: string[]; matched: boolean }> {
  const { supabase, question, regs, docs } = params;
  const cap = params.maxRowsPerSheet ?? 8000;
  const intent = detectIntent(question);
  const tokens = tokenize(question);
  const cites: string[] = [];
  const parts: string[] = [];

  // Load rows for every scoped sheet in parallel.
  const sheetRows = await Promise.all(
    regs.map(async (r) => {
      const rows = await fetchRows(supabase, r.id, cap);
      return { reg: r, rows };
    }),
  );

  for (const { reg, rows } of sheetRows) {
    if (rows.length === 0) continue;
    const cols = allColumns(rows);
    const statusCol = statusColumn(cols);
    const activeRows = rows.filter((r) => !isTerminal(r, statusCol));
    const matched = tokens.length > 0
      ? activeRows
          .map((row) => ({ row, score: rowMatchesTokens(row, tokens) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.row)
      : activeRows;
    const universe = matched.length > 0 ? matched : activeRows;

    const emitRow = (row: StoredRow, note?: string) => {
      const marker = `[sheet:${reg.display_name} row ${row.row_index + 1}]`;
      cites.push(marker);
      params.ledgerSink?.push({
        kind: "sheet_row",
        registryId: reg.id,
        sheetLabel: reg.display_name,
        rowIndex: row.row_index,
        data: row.data,
      });
      const preview = Object.entries(row.data)
        .filter(([, v]) => cellText(v) !== "")
        .slice(0, 5)
        .map(([k, v]) => `${k}: ${cellText(v).slice(0, 60)}`)
        .join(" · ");
      return `- ${note ? `${note} — ` : ""}${preview} ${marker}`;
    };

    if (intent.kind === "count") {
      parts.push(
        `**${reg.display_name}** — ${fmt(matched.length || activeRows.length)} matching rows${matched.length && matched.length !== activeRows.length ? ` (of ${fmt(activeRows.length)} active)` : ""}.`,
      );
      for (const r of universe.slice(0, 3)) parts.push(emitRow(r));
      continue;
    }

    if (intent.kind === "sum" || intent.kind === "avg" || intent.kind === "min" || intent.kind === "max") {
      const pick = pickNumericColumn(universe, cols, intent.hint);
      if (!pick) {
        parts.push(`**${reg.display_name}** — no numeric column detected for ${intent.kind}.`);
        continue;
      }
      const values = pick.values.map((v) => v.n);
      let value = 0;
      let extremeRow: StoredRow | null = null;
      if (intent.kind === "sum") value = values.reduce((a, b) => a + b, 0);
      else if (intent.kind === "avg") value = values.reduce((a, b) => a + b, 0) / values.length;
      else if (intent.kind === "min") {
        const found = pick.values.reduce((a, b) => (b.n < a.n ? b : a));
        value = found.n;
        extremeRow = found.row;
      } else if (intent.kind === "max") {
        const found = pick.values.reduce((a, b) => (b.n > a.n ? b : a));
        value = found.n;
        extremeRow = found.row;
      }
      parts.push(`**${reg.display_name}** — ${intent.kind} of \`${pick.column}\` = **${fmt(value)}** across ${fmt(values.length)} rows.`);
      if (extremeRow) parts.push(emitRow(extremeRow, `${intent.kind} row`));
      else for (const r of universe.slice(0, 2)) parts.push(emitRow(r));
      continue;
    }

    if (intent.kind === "top") {
      const pick = pickNumericColumn(universe, cols, intent.hint);
      if (!pick) {
        parts.push(`**${reg.display_name}** — no numeric column detected for a top-N ranking.`);
        continue;
      }
      const sorted = [...pick.values].sort((a, b) => (intent.direction === "highest" ? b.n - a.n : a.n - b.n));
      parts.push(`**${reg.display_name}** — ${intent.direction === "highest" ? "top" : "bottom"} ${Math.min(intent.n, sorted.length)} by \`${pick.column}\`:`);
      for (const { row, n } of sorted.slice(0, intent.n)) parts.push(emitRow(row, `${pick.column} = ${fmt(n)}`));
      continue;
    }

    if (intent.kind === "distribution") {
      const groupCol =
        (intent.hint && cols.find((c) => new RegExp(intent.hint!, "i").test(c))) ||
        statusCol ||
        pickColumn(cols, [/type/i, /category/i, /priority/i, /owner/i, /project/i, /vendor/i, /activity/i]);
      if (!groupCol) {
        parts.push(`**${reg.display_name}** — no group-by column detected.`);
        continue;
      }
      const counts = new Map<string, StoredRow[]>();
      for (const r of universe) {
        const key = cellText(r.data[groupCol]) || "(blank)";
        if (!counts.has(key)) counts.set(key, []);
        counts.get(key)!.push(r);
      }
      const entries = Array.from(counts.entries()).sort((a, b) => b[1].length - a[1].length);
      parts.push(`**${reg.display_name}** — distribution by \`${groupCol}\`:`);
      for (const [key, rs] of entries.slice(0, 10)) {
        const sample = rs[0];
        parts.push(`- ${key}: ${fmt(rs.length)} ${emitRowInline(sample, reg, cites, params.ledgerSink)}`);
      }
      continue;
    }

    // list / generic — return top matches
    const previewCount = intent.kind === "list" ? 10 : 6;
    if (universe.length === 0) {
      parts.push(`**${reg.display_name}** — 0 matching rows.`);
      continue;
    }
    parts.push(`**${reg.display_name}** — showing ${Math.min(previewCount, universe.length)} of ${fmt(universe.length)} matching rows:`);
    for (const r of universe.slice(0, previewCount)) parts.push(emitRow(r));
  }

  // Documents: keyword-hit snippets by page.
  if (docs.length > 0 && tokens.length > 0) {
    const { data: chunks } = await supabase
      .from("document_chunks")
      .select("document_id, page_no, content")
      .in("document_id", docs.map((d) => d.id))
      .limit(2000);
    const grouped = new Map<string, DocChunk[]>();
    for (const c of (chunks ?? []) as DocChunk[]) {
      const key = c.document_id;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(c);
    }
    for (const d of docs) {
      const list = grouped.get(d.id) ?? [];
      const scored = list
        .map((c) => {
          const text = (c.content ?? "").toLowerCase();
          let s = 0;
          for (const t of tokens) if (text.includes(t)) s += 1;
          return { c, s };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 4);
      if (scored.length === 0) continue;
      parts.push(`**${d.name}** — ${scored.length} relevant excerpt${scored.length === 1 ? "" : "s"}:`);
      for (const { c } of scored) {
        const page = c.page_no ?? 1;
        const snippet = (c.content ?? "").trim().replace(/\s+/g, " ").slice(0, 220);
        const marker = `[doc:${d.name} p.${page}]`;
        cites.push(marker);
        params.ledgerSink?.push({
          kind: "doc_chunk",
          documentId: d.id,
          documentName: d.name,
          pageNo: page,
          snippet,
        });
        parts.push(`- "${snippet}…" ${marker}`);
      }
    }
  }

  if (parts.length === 0) {
    return { answer: "", citations: [], matched: false };
  }

  const uniqCites = Array.from(new Set(cites));
  const answer =
    `Answered directly from the selected sources (AI provider unavailable — used local search over your sheets and documents):\n\n` +
    parts.join("\n") +
    (uniqCites.length ? `\n\nSources:\n${uniqCites.map((m) => `- ${m}`).join("\n")}` : "");
  return { answer, citations: uniqCites, matched: true };
}

function emitRowInline(
  row: StoredRow,
  reg: SheetReg,
  cites: string[],
  ledgerSink?: DeterministicLedgerEntry[],
): string {
  const marker = `[sheet:${reg.display_name} row ${row.row_index + 1}]`;
  cites.push(marker);
  ledgerSink?.push({
    kind: "sheet_row",
    registryId: reg.id,
    sheetLabel: reg.display_name,
    rowIndex: row.row_index,
    data: row.data,
  });
  return marker;
}

async function fetchRows(supabase: any, registryId: string, cap: number): Promise<StoredRow[]> {
  const PAGE = 1000;
  const out: StoredRow[] = [];
  for (let offset = 0; offset < cap; offset += PAGE) {
    const { data, error } = await supabase
      .from("sheet_rows")
      .select("row_index, canonical, extras")
      .eq("sheet_registry_id", registryId)
      .order("row_index", { ascending: true })
      .range(offset, Math.min(offset + PAGE - 1, cap - 1));
    if (error) break;
    if (!data || data.length === 0) break;
    for (const r of data as any[]) {
      out.push({
        row_index: r.row_index,
        data: {
          ...(((r.canonical as Record<string, unknown>) ?? {})),
          ...(((r.extras as Record<string, unknown>) ?? {})),
        },
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
