#!/usr/bin/env node
/**
 * Static check: every dashboard card & row must route to a real detail page,
 * never bounce back to the aggregate view.
 *
 * Rules enforced on src/components/AgentDashboard.tsx:
 *   1. KPI tiles use `/agent/kpi/$id`  (health, ontime, overdue, tat, risk, momentum)
 *   2. Bottleneck stage chart uses `/agent/stage/$key`
 *   3. Anomaly cards use `/agent/stage/$key`
 *   4. Top-performer / efficiency rows use `/agent/person/$key`
 *   5. Project chip "Open workspace" uses `/agent/project/$projectId`
 *   6. The aggregate route `/agent/detail/$payload` may only appear on row-level
 *      handlers (overdue queue, filtered report rows, anomaly-drilled rows).
 *      It MUST NOT be the target of KPI tiles, health card, or stage/person cards.
 *
 * Also verifies every referenced route file exists on disk.
 *
 * Run:  node scripts/check-dashboard-routes.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dashPath = resolve(root, "src/components/AgentDashboard.tsx");
const src = readFileSync(dashPath, "utf8");

const errors = [];
const ok = [];

// ── 1. Required route targets somewhere in the file ──────────────────────────
const REQUIRED = [
  { pattern: /to="\/agent\/kpi\/\$id"/,          label: "KPI tiles → /agent/kpi/$id" },
  { pattern: /to="\/agent\/stage\/\$key"/,       label: "Bottleneck/Anomaly → /agent/stage/$key" },
  { pattern: /to="\/agent\/person\/\$key"/,      label: "Top performers / Efficiency → /agent/person/$key" },
  { pattern: /to="\/agent\/project\/\$projectId"/, label: "Project workspace → /agent/project/$projectId" },
  { pattern: /"\/agent\/row\/\$key"/,            label: "Overdue queue / Filtered report → /agent/row/$key" },
];
for (const r of REQUIRED) {
  if (r.pattern.test(src)) ok.push(r.label);
  else errors.push(`MISSING route wiring — ${r.label}`);
}

// ── 2. Route files exist on disk ─────────────────────────────────────────────
const ROUTE_FILES = [
  "src/routes/_authenticated/agent.kpi.$id.tsx",
  "src/routes/_authenticated/agent.stage.$key.tsx",
  "src/routes/_authenticated/agent.person.$key.tsx",
  "src/routes/_authenticated/agent.project.$projectId.tsx",
  "src/routes/_authenticated/agent.row.$key.tsx",
  "src/routes/_authenticated/agent.detail.$payload.tsx",
];
for (const f of ROUTE_FILES) {
  if (existsSync(resolve(root, f))) ok.push(`route file present — ${f}`);
  else errors.push(`MISSING route file — ${f}`);
}

// ── 3. KPI strip must not bounce to /agent/detail/$payload ───────────────────
// Each <Kpi to={{ to: "...", params: {...} }} ... /> — extract each `to: "..."`.
const kpiUsages = [...src.matchAll(/<Kpi\s+to=\{\{\s*to:\s*"([^"]+)"/g)];
if (kpiUsages.length === 0) {
  errors.push("No <Kpi to={{...}}> usages found — dashboard KPI strip may be unlinked.");
}
for (const m of kpiUsages) {
  if (m[1] === "/agent/detail/$payload") {
    errors.push(`KPI tile still routes to aggregate: ${m[0]}`);
  }
}
ok.push(`inspected ${kpiUsages.length} KPI tiles`);


// ── 4. Bottleneck chart must navigate to stage page ─────────────────────────
const bottleneckRegion = src.match(/Bottleneck map \(stages\)[\s\S]{0,2000}?<\/BarChart>/);
if (!bottleneckRegion) {
  errors.push("Could not locate Bottleneck chart block.");
} else if (!/\/agent\/stage\/\$key/.test(bottleneckRegion[0])) {
  errors.push("Bottleneck chart does not navigate to /agent/stage/$key.");
} else {
  ok.push("Bottleneck chart wired to /agent/stage/$key");
}

// ── 5. Anomalies card must link to stage page, not aggregate ────────────────
const anomaliesRegion = src.match(/Anomalies[\s\S]{0,1500}?<\/Card>/);
if (!anomaliesRegion) {
  errors.push("Could not locate Anomalies card.");
} else {
  if (!/\/agent\/stage\/\$key/.test(anomaliesRegion[0])) {
    errors.push("Anomalies card does not link to /agent/stage/$key.");
  } else if (/\/agent\/detail\/\$payload/.test(anomaliesRegion[0])) {
    errors.push("Anomalies card still links to aggregate /agent/detail/$payload.");
  } else {
    ok.push("Anomalies card wired to /agent/stage/$key");
  }
}

// ── 6. Overdue queue must link to /agent/row/$key ───────────────────────────
const overdueRegion = src.match(/Overdue queue[\s\S]{0,2000}?<\/Card>/);
if (!overdueRegion) {
  errors.push("Could not locate Overdue queue block.");
} else if (!/\/agent\/row\/\$key/.test(overdueRegion[0])) {
  errors.push("Overdue queue does not link to /agent/row/$key.");
} else if (/\/agent\/detail\/\$payload/.test(overdueRegion[0])) {
  errors.push("Overdue queue still links to aggregate /agent/detail/$payload.");
} else {
  ok.push("Overdue queue wired to /agent/row/$key");
}

// ── 7. Filtered report rows must link to /agent/row/$key ────────────────────
const filteredRegion = src.match(/Filtered report[\s\S]{0,8000}?<\/Table>/);
if (!filteredRegion) {
  errors.push("Could not locate Filtered report block.");
} else if (!/\/agent\/row\/\$key/.test(filteredRegion[0])) {
  errors.push("Filtered report rows do not link to /agent/row/$key.");
} else if (/\/agent\/detail\/\$payload/.test(filteredRegion[0])) {
  errors.push("Filtered report rows still link to aggregate /agent/detail/$payload.");
} else {
  ok.push("Filtered report rows wired to /agent/row/$key");
}

// ── 8. No detailLink( call sites remain ─────────────────────────────────────
if (/\bdetailLink\s*\(/.test(src)) {
  errors.push("`detailLink(` call sites still remain in AgentDashboard.tsx.");
} else {
  ok.push("no detailLink() call sites remain");
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log("Dashboard route check");
console.log("=====================");
for (const line of ok) console.log("  ok  ·", line);
if (errors.length) {
  console.log("");
  for (const e of errors) console.error("  FAIL·", e);
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(`\nAll ${ok.length} checks passed.`);
