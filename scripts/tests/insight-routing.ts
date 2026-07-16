/**
 * Regression: Auto-Insights suggested questions with embedded numbers and
 * column names (e.g. "balance 2 or 3") must route to insight mode, NOT be
 * misparsed as row-identifier filter tokens.
 *
 *   bun run scripts/tests/insight-routing.ts
 */

import { isInsightShapedQuery } from "../../src/lib/copilot-deterministic.server";

type Case = { q: string; expect: boolean; note: string };

const cases: Case[] = [
  // Explain / why / discrepancy shapes — the shape most Auto-Insights
  // suggested questions take. MUST be insight-mode.
  { q: "Explain the discrepancy between consumed_qty and planned_qty", expect: true, note: "discrepancy between cols" },
  { q: "Why is balance 2 or 3 for these rows?", expect: true, note: "why + numbers" },
  { q: "Explain why balance is negative", expect: true, note: "explain why" },
  { q: "What's the variance between planned and received?", expect: true, note: "variance between" },
  { q: "Reconcile planned_qty against consumed_qty", expect: true, note: "reconcile" },
  { q: "Root cause of variance in stock summary sheet", expect: true, note: "root cause + sheet" },
  { q: "Difference between amount_claimed and amount_paid", expect: true, note: "difference between X and Y" },

  // Broad summary asks — insight-mode.
  { q: "Summarize this sheet", expect: true, note: "sheet-wide summary" },
  { q: "Give me an overview of the data", expect: true, note: "overview of data" },
  { q: "What are the key takeaways from all sources?", expect: true, note: "key takeaways all" },

  // Targeted entity asks — NOT insight-mode.
  { q: "Summarize the row for Punjab_Kharar_Store", expect: false, note: "targeted row" },
  { q: "Highlights of samastipur", expect: false, note: "highlights of entity" },
  { q: "Snapshot of NIT-48", expect: false, note: "snapshot of id" },
  { q: "Show details for Kunti Devi", expect: false, note: "details for person" },

  // Neutral lookups — NOT insight-mode.
  { q: "Which contracts expire in the next 30 days?", expect: false, note: "temporal lookup" },
  { q: "List all overdue tasks", expect: false, note: "list lookup" },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = isInsightShapedQuery(c.q);
  if (got === c.expect) {
    pass += 1;
    console.log(`  ✓ ${c.note}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${c.note} — expected ${c.expect}, got ${got}`);
    console.error(`      "${c.q}"`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (${cases.length} total)`);
if (fail > 0) process.exit(1);
