#!/usr/bin/env bun
/**
 * Validation test for chatbot tool grounding, cache behaviour, and
 * OpenRouter fallback routing. Run with `bun run test:openrouter`.
 *
 * The test intentionally avoids Supabase and does NOT hit the live model —
 * we exercise the same tool factory and fallback fetch chain the API route
 * uses at runtime.
 */
import { tool } from "ai";
import { buildTools } from "../../src/routes/api/chat";
import {
  _resetAgentCache,
  ctxFingerprintSync,
} from "../../src/lib/agent-cache.server";
import { createFallbackFetch } from "../../src/lib/ai-fallback.server";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`✔ ${name}`); passed++; }
  else { console.error(`✘ ${name}`, detail ?? ""); failed++; }
}

// ---------- Fixture: what a filtered dashboard looks like ----------
const CTX = {
  projectId: "pspcl",
  projectLabel: "PSPCL",
  rowScope: "overdue",
  lastSyncedAt: "2026-07-13T17:41:00Z",
  totals: { rows: 3, next_best_actions: 2 },
  riskScore: 78,
  rows: [
    { sheet: "PSPCL", row_index: 12, activity: "Foundation pour", person: "Ravi", stage: "Civil", status: "overdue", tat: 5, days_taken: 12, delay: 7, criticality: "high" },
    { sheet: "PSPCL", row_index: 27, activity: "Rebar tie-up", person: "Suman", stage: "Civil", status: "overdue", tat: 3, days_taken: 4, delay: 1, criticality: "med" },
    { sheet: "PSPCL", row_index: 41, activity: "Trafo commissioning", person: "Ravi", stage: "Elec", status: "overdue", tat: 10, days_taken: 22, delay: 12, criticality: "high" },
  ],
  tatRows: [
    { sheet: "PSPCL", row_index: 41, activity: "Trafo commissioning", tat: 10, days_taken: 22, delta: 12, status: "overdue", person: "Ravi", stage: "Elec", criticality: "high", citation: "[sheet:PSPCL row 41]" },
    { sheet: "PSPCL", row_index: 12, activity: "Foundation pour", tat: 5, days_taken: 12, delta: 7, status: "overdue", person: "Ravi", stage: "Civil", criticality: "high", citation: "[sheet:PSPCL row 12]" },
    { sheet: "PSPCL", row_index: 27, activity: "Rebar tie-up", tat: 3, days_taken: 4, delta: 1, status: "overdue", person: "Suman", stage: "Civil", criticality: "med", citation: "[sheet:PSPCL row 27]" },
  ],
  personRanking: [
    { person: "Ravi", delay_count: 2, total_overdue_days: 19, activities: ["Foundation pour", "Trafo commissioning"] },
    { person: "Suman", delay_count: 1, total_overdue_days: 1, activities: ["Rebar tie-up"] },
  ],
  flags: [
    { id: "f1", activity: "Trafo commissioning", severity: "critical", status: "open", stage: "Elec", reason_text: "12 days over TAT", sheet: "PSPCL", row_index: 41, citation: "[sheet:PSPCL row 41]", flagged_to: { person: "Ravi" } },
  ],
  actions: [
    { source: "auto", title: "Escalate Trafo commissioning", detail: "Ravi is 12d over", severity: "critical", person: "Ravi", stage: "Elec", sheet: "PSPCL", row_index: 41, citation: "[sheet:PSPCL row 41]" },
    { source: "auto", title: "Nudge Suman on Rebar", detail: "1d over", severity: "warning", person: "Suman", stage: "Civil", sheet: "PSPCL", row_index: 27, citation: "[sheet:PSPCL row 27]" },
  ],
};

async function testToolGrounding() {
  _resetAgentCache();
  const fp = ctxFingerprintSync(CTX);
  const run = { toolCalls: [] as Array<{ name: string; input: unknown; output?: unknown; ms?: number }> };
  const tools = buildTools(CTX as never, run, null, tool as never, fp);

  const sum = await (tools.getDashboardSummary as { execute: (i: unknown) => Promise<unknown> }).execute({});
  check("getDashboardSummary returns project label", (sum as { project?: string }).project === "PSPCL", sum);

  const top = await (tools.topDelays as { execute: (i: unknown) => Promise<unknown> }).execute({ limit: 2 });
  const topItems = (top as { items: Array<{ activity: string; days_over: number; citation: string }> }).items;
  check("topDelays sorts by days_over desc", topItems[0]?.activity === "Trafo commissioning" && topItems[0]?.days_over === 12);
  check("topDelays returns exact citation", topItems[0]?.citation === "[sheet:PSPCL row 41]");
  check("topDelays honours limit", topItems.length === 2);

  const ravi = await (tools.getPersonWorkload as { execute: (i: unknown) => Promise<unknown> }).execute({ person: "Ravi" });
  check("getPersonWorkload finds person case-insensitive", (ravi as { found: boolean }).found === true);
  check("getPersonWorkload aggregates overdue days", (ravi as { total_overdue_days: number }).total_overdue_days === 19);

  const filt = await (tools.filterActivities as { execute: (i: unknown) => Promise<unknown> }).execute({ person: "Suman", stage: null, status: null, query: null });
  const filtItems = (filt as { items: Array<{ person: string; row_index: number }> }).items;
  check("filterActivities scopes to person", filtItems.length === 1 && filtItems[0]?.row_index === 27);

  const alerts = await (tools.getOpenAlerts as { execute: (i: unknown) => Promise<unknown> }).execute({ severity: "critical" });
  const alertItems = (alerts as { items: Array<{ id: string; citation: string }> }).items;
  check("getOpenAlerts filters by severity + carries citation", alertItems.length === 1 && alertItems[0]?.citation === "[sheet:PSPCL row 41]");

  const nba = await (tools.getNextBestActions as { execute: (i: unknown) => Promise<unknown> }).execute({ limit: null });
  check("getNextBestActions preserves dashboard order", (nba as { items: Array<{ title: string }> }).items[0]?.title === "Escalate Trafo commissioning");
}

async function testCache() {
  _resetAgentCache();
  const fp = ctxFingerprintSync(CTX);
  const run = { toolCalls: [] as Array<{ name: string; input: unknown; output?: unknown; ms?: number }> };
  const tools = buildTools(CTX as never, run, null, tool as never, fp);

  const first = await (tools.topDelays as { execute: (i: unknown) => Promise<unknown> }).execute({ limit: 3 });
  const second = await (tools.topDelays as { execute: (i: unknown) => Promise<unknown> }).execute({ limit: 3 });
  check("cache returns identical output on repeat call", JSON.stringify(first) === JSON.stringify(second));
  const [, cachedCall] = run.toolCalls.filter((c) => c.name === "topDelays");
  check("cache hit reports ms === 0", cachedCall?.ms === 0, cachedCall);

  // Different input → cache miss, fresh execution.
  const third = await (tools.topDelays as { execute: (i: unknown) => Promise<unknown> }).execute({ limit: 1 });
  check("different input misses cache", (third as { items: unknown[] }).items.length === 1);
}

async function testOpenRouterFallback() {
  process.env.LOVABLE_API_KEY = "test-lovable";
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.OPENROUTER_API_KEY = "test-or";
  delete process.env.GROQ_API_KEY;

  const seen: Array<{ url: string; model?: string; auth?: string }> = [];
  const baseFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let model: string | undefined;
    try {
      const body = init?.body;
      if (typeof body === "string") model = JSON.parse(body).model;
    } catch { /* ignore */ }
    const auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    seen.push({ url, model, auth });

    if (url.includes("ai.gateway.lovable.dev")) {
      return new Response("credits exhausted", { status: 402 });
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response("quota", { status: 429 });
    }
    if (url.includes("openrouter.ai")) {
      // Simulate a successful tool-calling response.
      return new Response(
        JSON.stringify({
          id: "cmpl-fake",
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "topDelays", arguments: JSON.stringify({ limit: 3 }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected", { status: 500 });
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = baseFetch as typeof fetch;

  const fetchWithFallback = createFallbackFetch(baseFetch);
  const res = await fetchWithFallback("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": "test-lovable" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "user", content: "top delays?" }],
      tools: [{ type: "function", function: { name: "topDelays", parameters: {} } }],
    }),
  });
  globalThis.fetch = originalFetch;

  check("fallback walked gateway → gemini → openrouter", seen.length >= 3 && seen[0].url.includes("lovable.dev") && seen[1].url.includes("googleapis.com") && seen[2].url.includes("openrouter.ai"));
  const orCall = seen.find((s) => s.url.includes("openrouter.ai"));
  check("openrouter call uses a free-tier model", (orCall?.model ?? "").endsWith(":free"), orCall);
  check("openrouter auth swapped to OpenRouter key", orCall?.auth === "Bearer test-or");
  check("final response OK from openrouter", res.status === 200);

  const json = await res.json() as { choices: Array<{ message: { tool_calls: Array<{ function: { name: string; arguments: string } }> } }> };
  const call = json.choices[0]?.message?.tool_calls?.[0];
  check("openrouter response carries tool_call for topDelays", call?.function?.name === "topDelays");
  const args = call?.function?.arguments ? JSON.parse(call.function.arguments) : {};
  check("tool_call arguments round-trip through fallback", args.limit === 3);
}

async function main() {
  console.log("── tool grounding ──");
  await testToolGrounding();
  console.log("── cache ──");
  await testCache();
  console.log("── openrouter fallback ──");
  await testOpenRouterFallback();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
