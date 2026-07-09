// Automated tests that lock in the chatbot's grounding + citation contract.
// Run with: bun run scripts/tests/citation-contract.ts
//
// These tests are pure-function checks against the shared parser used by
// both the UI and the server prompt. If the model contract changes, both
// the prompt and this file must be updated together.

import {
  REFUSAL_PHRASE,
  extractCitations,
  parseRefusal,
  findUncitedFactualSentences,
  stripCitations,
} from "../../src/lib/citation-parser";

type Case = { name: string; run: () => void };
const cases: Case[] = [];
function test(name: string, run: () => void) {
  cases.push({ name, run });
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg?: string) {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg ?? "eq"}: expected ${B}, got ${A}`);
}

test("extracts sheet, doc, and dashboard citations", () => {
  const text = `Owner is Ravi [sheet:Site Log row 12]. Contract clause [doc:MSA.pdf p.4]. Overdue count [dashboard:totals.overdue].`;
  const cs = extractCitations(text);
  eq(cs.length, 3);
  eq(cs[0], { kind: "sheet", label: "Site Log", row: 12 });
  eq(cs[1], { kind: "doc", label: "MSA.pdf", page: 4 });
  eq(cs[2], { kind: "dashboard", field: "totals.overdue" });
});

test("dedupes repeated citations", () => {
  const text = `A [sheet:X row 1] B [sheet:X row 1] C [dashboard:riskScore] D [dashboard:riskScore]`;
  eq(extractCitations(text).length, 2);
});

test("refusal detected with fixed phrase + missing list", () => {
  const text = `${REFUSAL_PHRASE}\nMissing: budget column, contractor sheet\nTry uploading the finance sheet.`;
  const r = parseRefusal(text);
  assert(r.isRefusal, "should be refusal");
  eq(r.missing, ["budget column", "contractor sheet"]);
});

test("non-refusal answer is not flagged as refusal", () => {
  const r = parseRefusal("Ravi has 3 overdue items [sheet:Site row 12].");
  assert(!r.isRefusal, "should not be refusal");
});

test("paraphrased refusal fails the fixed-phrase contract", () => {
  const r = parseRefusal("I do not have that data in the dashboard.");
  assert(!r.isRefusal, "paraphrased refusals must fail the contract");
});

test("factual sentences without citations are flagged", () => {
  const text = `Ravi has 4 overdue activities. Sources: [sheet:Site row 12]`;
  const bad = findUncitedFactualSentences(text);
  assert(bad.length === 1, `expected 1 uncited sentence, got ${bad.length}`);
});

test("factual sentences with inline citations pass", () => {
  const text = `Ravi has 4 overdue activities [sheet:Site row 12]. Risk score is 72 [dashboard:riskScore].
Sources: [sheet:Site row 12], [dashboard:riskScore]`;
  const bad = findUncitedFactualSentences(text);
  eq(bad, []);
});

test("refusal message body is exempt from the uncited-facts check", () => {
  const text = `${REFUSAL_PHRASE}\nMissing: invoice PDFs`;
  const bad = findUncitedFactualSentences(text);
  eq(bad, []);
});

test("stripCitations removes all tag types", () => {
  const s = stripCitations("A [sheet:X row 1] B [doc:Y.pdf p.2] C [dashboard:z]");
  eq(s, "A B C");
});

test("system prompt requires the exact refusal phrase and citation formats", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/routes/api/chat.ts", "utf8");
  assert(src.includes(REFUSAL_PHRASE), "system prompt must contain the fixed refusal phrase");
  assert(src.includes("[sheet:<sheet display name> row <row_index>]"), "sheet citation format required");
  assert(src.includes("[doc:<document name> p.<page_no>]"), "doc citation format required");
  assert(src.includes("[dashboard:<field>]"), "dashboard citation format required");
  assert(/Missing:/i.test(src), "prompt must instruct model to emit a Missing: line");
});

let passed = 0;
let failed = 0;
for (const c of cases) {
  try {
    // Tests may be async in the future — await for safety.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = c.run();
    if (r && typeof r.then === "function") await r;
    console.log(`  ✓ ${c.name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${c.name}\n     ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
