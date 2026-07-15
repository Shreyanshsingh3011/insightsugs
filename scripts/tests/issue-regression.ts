/**
 * Regression suite for the 12 reported testing issues.
 * Runs the pure logic (query-match, status-utils, schema-retry) against
 * synthetic rows that mirror each reported bug. No DB / network access.
 *
 *   bun run scripts/tests/issue-regression.ts
 */

import {
  strictPhrases,
  matchesAllPhrases,
  normalizeHaystack,
  matchesExactTarget,
  extractSerialNumber,
  extractRequestedColumns,
  describeSearchedColumns,
  hasStrictTarget,
  contentTokens,
} from "../../src/lib/query-match";
import { deterministicAnswer } from "../../src/lib/copilot-deterministic.server";
import {
  computeRowStatus,
  isRowEffectivelyDone,
  isTerminalRow,
  recomputeDaysTaken,
  sanitizedDelayDays,
} from "../../src/lib/status-utils";
import { withSchemaHeal, isSchemaCacheError } from "../../src/lib/schema-retry";

type Case = { id: string; title: string; run: () => void };
const cases: Case[] = [];
const test = (id: string, title: string, run: () => void) => cases.push({ id, title, run });

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
}
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`FAIL: ${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

/* ── Query-match: Issues #1, #2, #4, #5 ── */

test("#1", "Exact-name lookup does not leak surname collisions", () => {
  const phrases = strictPhrases("phone number of Kunti Devi");
  assert(phrases.includes("kunti devi"), "must require full name as phrase");
  const kunti = normalizeHaystack(["Kunti Devi", "9999900000"]);
  const ram = normalizeHaystack(["Ram Devi", "8888800000"]);
  assert(matchesAllPhrases(kunti, phrases), "Kunti Devi row should match");
  assert(!matchesAllPhrases(ram, phrases), "Ram Devi row must NOT match");
});

test("#2", "ALL-CAPS proper noun stays contiguous", () => {
  const phrases = strictPhrases("status for MANKA BIBI");
  assert(phrases.includes("manka bibi"), "ALL-CAPS multi-word treated as phrase");
  assert(!matchesAllPhrases(normalizeHaystack(["MANKA DEVI"]), phrases), "must not match MANKA DEVI");
});

test("#4", "Serial-number lookup resolves to S.No column", () => {
  eq(extractSerialNumber("show me sno 67"), 67, "sno 67");
  eq(extractSerialNumber("S. No. 12 details"), 12, "S. No. 12");
  eq(extractSerialNumber("what is Sr No 4"), 4, "Sr No 4");
  eq(extractSerialNumber("hello world"), null, "no serial in generic query");
});

test("#5", "Identifier codes like IT76 stay strict", () => {
  const phrases = strictPhrases("delay for IT76");
  assert(phrases.some((p) => p === "it76"), "IT76 required as identifier");
  assert(matchesAllPhrases(normalizeHaystack(["IT76 - Foundation"]), phrases));
  assert(!matchesAllPhrases(normalizeHaystack(["IT77 - Roof"]), phrases), "IT77 must NOT satisfy IT76");
});

test("#5b", "Cross-column tender identifiers match without contiguous row text", () => {
  const query = "nbpdcl nit 48 samastipur";
  const phrases = strictPhrases(query);
  const tokens = contentTokens(query);
  const hay = normalizeHaystack(["Tender No", "NIT 48", "District", "Samastipur", "Client", "NBPDCL"]);
  assert(phrases.includes("nbpdcl nit 48 samastipur"), "full code-like phrase is required");
  assert(!matchesAllPhrases(hay, phrases), "non-adjacent columns are not a contiguous phrase hit");
  assert(matchesExactTarget(hay, phrases, tokens), "code-like tokens may match across columns");
});

/* ── Status derivation: Issues #6, #8, #9 ── */

test("#6", "TAT=45 Days Taken=31 → Timely Completed (not Late)", () => {
  const row = { "TAT": 45, "Days Taken": 31, "Status": "Completed" };
  const s = computeRowStatus(row);
  eq(s.bucket, "Completed", "bucket");
  eq(s.label, "Timely Completed", "label");
  assert(s.isDone, "isDone true");
  assert(!s.isDelayed, "not delayed");
});

test("#8", "TAT=30 Days Taken=31 → Late Completed with delay=1", () => {
  const row = { "TAT": 30, "Days Taken": 31, "Status": "Done" };
  const s = computeRowStatus(row);
  eq(s.bucket, "Completed", "bucket");
  eq(s.label, "Late Completed", "label");
  eq(s.delay, 1, "delay=1");
});

test("#9", "In-progress row with completion-date column must NOT flip to Completed", () => {
  const row = {
    "Status": "In Progress",
    "TAT": 20,
    "Days Taken": 15,
    "Completion Date": "", // empty — active row
    "Actual Date": "01/07/2026", // stray formula output
  };
  const s = computeRowStatus(row);
  assert(!s.isDone, "still active");
  assert(s.bucket !== "Completed", "not bucketed as Completed");
});

test("#9b", "Effectively-done ignores date-serial in duration column when Status says delayed", () => {
  const row = { "Status": "Delay by 12 days", "Delay in Days": 45123, "TAT": 30 };
  assert(!isRowEffectivelyDone(row), "delayed status wins over serial leak");
  eq(sanitizedDelayDays(row), 12, "delay parsed from status text");
});

test("#9c", "recomputeDaysTaken overrides broken sheet value", () => {
  const row = { "Start Date": "2026-06-01", "Completion Date": "2026-06-10", "Days Taken": 31 };
  eq(recomputeDaysTaken(row), 9, "9 days between start and completion");
});


test("#9d", "isTerminalRow true when % Complete = 100", () => {
  assert(isTerminalRow({ "% Complete": "100" }), "100% complete → terminal");
});

/* ── Schema-heal: Issues #3, #10, #11, #12 ── */

test("#3", "isSchemaCacheError recognises PGRST002 and message text", () => {
  assert(isSchemaCacheError({ code: "PGRST002", message: "" }));
  assert(isSchemaCacheError({ message: "Could not query the database for the schema cache" }));
  assert(isSchemaCacheError({ code: "PGRST205" }));
  assert(!isSchemaCacheError({ code: "23505", message: "duplicate" }));
});

test("#10", "withSchemaHeal retries transient schema-cache failures", async () => {
  let calls = 0;
  const res = await withSchemaHeal(async () => {
    calls++;
    if (calls < 3) {
      const e = new Error("Could not query the database for the schema cache") as Error & { code?: string };
      e.code = "PGRST002";
      throw e;
    }
    return "ok";
  }, 4, "test");
  eq(res, "ok", "eventually succeeds");
  eq(calls, 3, "took 3 attempts");
});

test("#11", "withSchemaHeal does NOT retry non-cache errors", async () => {
  let calls = 0;
  let threw = false;
  try {
    await withSchemaHeal(async () => {
      calls++;
      throw new Error("unique_violation");
    }, 4, "test");
  } catch { threw = true; }
  assert(threw, "propagated");
  eq(calls, 1, "no retry for unrelated errors");
});

test("#12", "withSchemaHeal gives up after N attempts", async () => {
  let calls = 0;
  let threw = false;
  try {
    await withSchemaHeal(async () => {
      calls++;
      const e = new Error("schema cache stale") as Error & { code?: string };
      e.code = "PGRST002";
      throw e;
    }, 3, "test");
  } catch { threw = true; }
  assert(threw, "final error surfaces");
  eq(calls, 3, "attempted exactly 3 times");
});

/* ── Grounding-failure explainer (chatbot fallback) ── */

test("#extra", "describeSearchedColumns highlights name/activity columns", () => {
  const desc = describeSearchedColumns([
    { display_name: "Bihar", headers: ["S.No", "Activity", "Owner", "TAT", "Status"] },
  ]);
  assert(desc.toLowerCase().includes("activity"), "activity mentioned");
  assert(desc.toLowerCase().includes("owner"), "owner mentioned");
  assert(hasStrictTarget("phone of Arpita Das"), "specific query flagged");
});

test("#copilot-column-count", "Total-row count searches only requested columns and not active-only rows", () => {
  const query = "How many total rows have 'Contractor not available' explicitly mentioned in the 'Store' or 'Contractor' column?";
  const rows = [
    { Store: "Contractor not available", Contractor: "", Status: "Excel Pending", Notes: "" },
    { Store: "", Contractor: "Contractor not available", Status: "Completed", Notes: "" },
    { Store: "", Contractor: "", Status: "Completed", Notes: "Contractor not available" },
  ];
  const columns = Object.keys(rows[0]);
  const requested = extractRequestedColumns(query, columns);
  eq(requested.join("|"), "Store|Contractor", "requested Store/Contractor columns only");
  const requestedNorms = new Set(requested.map((col) => col.toLowerCase()));
  const targetPhrases = strictPhrases(query).filter((phrase) => !requestedNorms.has(phrase));
  assert(targetPhrases.includes("contractor not available"), "quoted target phrase stays required");
  const targetTokens = contentTokens(query).filter((token) => !requested.some((col) => col.toLowerCase() === token));
  const hits = rows.filter((row) => {
    const hay = normalizeHaystack(requested.map((col) => row[col as keyof typeof row]));
    return targetPhrases.length > 0
      ? matchesAllPhrases(hay, targetPhrases)
      : targetTokens.every((token) => hay.includes(token));
  });
  eq(hits.length, 2, "counts completed + active rows, but excludes Notes-only hit");
});

test("#copilot-nbpdcl", "Deterministic Copilot strict mode answers split-column NBPDCL NIT 48 Samastipur", async () => {
  const registryId = "11111111-1111-1111-1111-111111111111";
  const rows = [
    {
      row_index: 0,
      canonical: {
        "Tender No": "NIT 48",
        District: "Samastipur",
        Client: "NBPDCL",
        Unit: "Nos",
        Status: "Active",
      },
      extras: { Scope: "Rural electrification package" },
    },
    {
      row_index: 1,
      canonical: {
        "Tender No": "NIT 48",
        District: "Patna",
        Client: "SBPDCL",
        Unit: "Nos",
        Status: "Active",
      },
      extras: {},
    },
  ];
  const supabase = {
    from(table: string) {
      assert(table === "sheet_rows", "only sheet_rows should be queried for this regression");
      return {
        select() { return this; },
        eq(column: string, value: string) {
          assert(column === "sheet_registry_id", "filters by registry id");
          assert(value === registryId, "uses selected sheet id");
          return this;
        },
        order() { return this; },
        async range() { return { data: rows, error: null }; },
      };
    },
  };

  const result = await deterministicAnswer({
    supabase,
    question: "nbpdcl nit 48 samastipur",
    regs: [{ id: registryId, display_name: "Tender Tracker", row_count: rows.length }],
    docs: [],
    strictMatch: true,
  });

  assert(result.matched, "strict deterministic path should match the selected row");
  assert(result.answer.includes("NBPDCL"), "answer includes the actual matching client");
  assert(result.answer.includes("Samastipur"), "answer includes the actual matching district");
  assert(result.answer.includes("[sheet:Tender Tracker row 1]"), "answer cites the exact row");
  assert(!/No exact match/i.test(result.answer), "must not ask for clarification when exact split-column match exists");
  assert(!/Did you mean[\s\S]*Nos/i.test(result.answer), "must not suggest generic unit values like Nos");
});

/* ── Runner ── */

async function main() {
  let pass = 0, fail = 0;
  for (const c of cases) {
    try {
      await c.run();
      console.log(`  ✓ ${c.id.padEnd(6)} ${c.title}`);
      pass++;
    } catch (e) {
      console.log(`  ✗ ${c.id.padEnd(6)} ${c.title}`);
      console.log(`      ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed (of ${cases.length})`);
  if (fail > 0) process.exit(1);
}

main();
