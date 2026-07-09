// Shared parser used by the chat widget UI and the automated citation tests.
// Keeps the refusal phrase and citation regexes in one place so the model
// contract, the UI, and the test suite cannot drift apart.

export const REFUSAL_PHRASE = "I don't have that in the current dashboard data.";

export type SheetCitation = { kind: "sheet"; label: string; row: number };
export type DocCitation = { kind: "doc"; label: string; page: number };
export type DashboardCitation = { kind: "dashboard"; field: string };
export type AnyCitation = SheetCitation | DocCitation | DashboardCitation;

const SHEET_RE = /\[sheet:([^\]]+?)\s+row\s+(\d+)\]/gi;
const DOC_RE = /\[doc:([^\]]+?)\s+p\.(\d+)\]/gi;
const DASH_RE = /\[dashboard:([^\]]+?)\]/gi;

export function extractCitations(text: string): AnyCitation[] {
  const out: AnyCitation[] = [];
  const seen = new Set<string>();
  const push = (c: AnyCitation, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  let m: RegExpExecArray | null;
  SHEET_RE.lastIndex = 0;
  while ((m = SHEET_RE.exec(text)) !== null) {
    push({ kind: "sheet", label: m[1].trim(), row: Number(m[2]) }, `s:${m[1]}:${m[2]}`);
  }
  DOC_RE.lastIndex = 0;
  while ((m = DOC_RE.exec(text)) !== null) {
    push({ kind: "doc", label: m[1].trim(), page: Number(m[2]) }, `d:${m[1]}:${m[2]}`);
  }
  DASH_RE.lastIndex = 0;
  while ((m = DASH_RE.exec(text)) !== null) {
    push({ kind: "dashboard", field: m[1].trim() }, `x:${m[1]}`);
  }
  return out;
}

// Strips citation tags to check whether any factual sentence in the answer
// was left uncited. Used by tests to enforce the "every fact cited" rule.
export function stripCitations(text: string): string {
  return text
    .replace(SHEET_RE, "")
    .replace(DOC_RE, "")
    .replace(DASH_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type RefusalInfo = {
  isRefusal: boolean;
  missing: string[];
};

// Detect the fixed refusal phrase and pull the "Missing:" list the model
// is required to emit right after it.
export function parseRefusal(text: string): RefusalInfo {
  const isRefusal = text.trim().startsWith(REFUSAL_PHRASE);
  if (!isRefusal) return { isRefusal: false, missing: [] };
  const missingLine = text.match(/Missing:\s*([^\n]+)/i);
  const missing = missingLine
    ? missingLine[1]
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  return { isRefusal: true, missing };
}

// Sentences that make a factual claim (mention a person, a number, a date,
// a status, etc.) MUST include at least one citation tag. This is a
// heuristic used by the automated test to fail obviously ungrounded answers.
const FACT_HINT_RE =
  /\b(\d+(\.\d+)?%?|overdue|late|delay|blocked|completed|assigned|owner|risk|days?|hours?|weeks?|approved|rejected|pending|alert|concern|project|sheet|row|activity|activities)\b/i;

export function findUncitedFactualSentences(text: string): string[] {
  // Ignore anything after "Sources:" — that's the citation footer.
  const body = text.split(/^\s*Sources?:/im)[0];
  const sentences = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^[-*•]\s*$/.test(s));
  const bad: string[] = [];
  for (const s of sentences) {
    if (s.startsWith(REFUSAL_PHRASE)) continue;
    if (/^(Missing|Sources?|Note|Tip|Queued for)\b/i.test(s)) continue;
    const hasCitation = /\[(sheet|doc|dashboard):/i.test(s);
    if (!hasCitation && FACT_HINT_RE.test(s)) bad.push(s);
  }
  return bad;
}
