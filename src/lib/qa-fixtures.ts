// QA data fixtures — synthetic sheet payloads for reproducing edge-case bugs.
// Activated via the QaDataSwitcher UI (localStorage `qa:scenario`). When a
// scenario is active, useAgentSources swaps live sheet rows for these before
// person-decoration/scoping — so every downstream page (dashboard, alerts,
// project health, KPI drilldowns, briefings, agent inbox) sees the fixture.

import type { Row } from "@/lib/entity-scope";
import type { AgentProject } from "@/lib/agent-registry.functions";

export type QaScenarioId =
  | "off"
  | "empty"
  | "single"
  | "many-alerts"
  | "long-list"
  | "no-delays"
  | "date-serial-leak"
  | "missing-owners";

export const QA_SCENARIOS: { id: QaScenarioId; label: string; description: string }[] = [
  { id: "off",              label: "Live data (off)",       description: "Use real sheets. Default." },
  { id: "empty",            label: "Empty (0 rows)",        description: "Every project has zero activities. Tests empty states." },
  { id: "single",           label: "Single row",            description: "Exactly one row per project." },
  { id: "many-alerts",      label: "50 overdue alerts",     description: "50 heavily-overdue rows in NIT-58. Stress-tests /alerts and KPI totals." },
  { id: "long-list",        label: "Long list (500 rows)",  description: "500 rows in Himachal. Tests table virtualization + export." },
  { id: "no-delays",        label: "No delays / empty corr",description: "All rows on-track with zero delay. Correlations should be empty." },
  { id: "date-serial-leak", label: "Excel date-serial leak",description: "Delay/TAT columns leak 46000+ serials. Tests sanitization + row-quality badges." },
  { id: "missing-owners",   label: "Missing owners",        description: "No Responsible Person / email set. Tests unassigned fallback." },
];

const STAGES = ["Pre-Tender", "Tender", "Pre-Award", "Award", "Execution", "Handover"];
const OWNERS = [
  { name: "Akash Singh",   email: "akash@sugslloyds.com" },
  { name: "Rakesh Sharma", email: "r.sharma@sugslloyds.com" },
  { name: "Yash",          email: "yash@sugslloyds.com" },
  { name: "Priya Nair",    email: "priya@sugslloyds.com" },
  { name: "Vikas Kumar",   email: "vikas@sugslloyds.com" },
];

function daysAgoISO(d: number): string {
  const t = new Date();
  t.setDate(t.getDate() - d);
  return t.toISOString().slice(0, 10);
}

function mkRow(i: number, opts: {
  stage?: string;
  owner?: { name: string; email: string } | null;
  tat?: number;
  taken?: number;
  delay?: number;
  status?: string;
  activity?: string;
  serialLeak?: boolean;
}): Row {
  const owner = opts.owner ?? OWNERS[i % OWNERS.length];
  const stage = opts.stage ?? STAGES[i % STAGES.length];
  return {
    "Sr. No.": i + 1,
    "Stages": stage,
    "Stages of Process": stage,
    "Activity List": opts.activity ?? `QA activity #${i + 1}`,
    "Process Descriptions": `Synthetic row ${i + 1} for QA scenarios`,
    "Responsible Person": owner ? owner.name : "",
    "Responsible Person Mail ID": owner ? owner.email : "",
    "Department": ["Ops", "Legal", "Finance", "Engg"][i % 4],
    "Planned Start Date": daysAgoISO(60 + (i % 10)),
    "Planned Completion Date": daysAgoISO(opts.delay && opts.delay > 0 ? opts.delay : -5),
    "TAT": opts.serialLeak && i % 3 === 0 ? 46029 : (opts.tat ?? 15),
    "Days Taken": opts.serialLeak && i % 3 === 1 ? 46028 : (opts.taken ?? (opts.delay && opts.delay > 0 ? (opts.tat ?? 15) + opts.delay : Math.max(1, (opts.tat ?? 15) - 2))),
    "Delay (In Days)": opts.serialLeak && i % 3 === 2 ? 46030 : (opts.delay ?? 0),
    "Status": opts.status ?? (opts.delay && opts.delay > 0 ? "In Progress" : "Completed"),
  };
}

function buildRowsForScenario(id: QaScenarioId, project: AgentProject): Row[] {
  switch (id) {
    case "empty":
      return [];
    case "single":
      return [mkRow(0, { delay: 3, status: "In Progress" })];
    case "many-alerts":
      if (project.id !== "nit58") return [mkRow(0, { delay: 0, status: "Completed" })];
      return Array.from({ length: 50 }, (_, i) =>
        mkRow(i, { delay: 5 + (i * 3), status: "In Progress", tat: 10 + (i % 20) }),
      );
    case "long-list":
      if (project.id !== "hp") return Array.from({ length: 5 }, (_, i) => mkRow(i, { delay: i % 2 ? 2 : 0 }));
      return Array.from({ length: 500 }, (_, i) =>
        mkRow(i, {
          delay: i % 7 === 0 ? 10 + (i % 30) : 0,
          status: i % 7 === 0 ? "In Progress" : "Completed",
          activity: `Row ${i + 1} — long-list stress test`,
        }),
      );
    case "no-delays":
      return Array.from({ length: 12 }, (_, i) =>
        mkRow(i, { delay: 0, taken: 8, tat: 15, status: "Completed" }),
      );
    case "date-serial-leak":
      return Array.from({ length: 8 }, (_, i) =>
        mkRow(i, { delay: 4, status: "In Progress", serialLeak: true }),
      );
    case "missing-owners":
      return Array.from({ length: 6 }, (_, i) =>
        mkRow(i, { delay: i % 2 ? 12 : 0, owner: null, status: i % 2 ? "In Progress" : "Completed" }),
      );
    case "off":
    default:
      return [];
  }
}

/** Build a fake payload for one project. Returns null for `off`. */
export function buildQaPayload(
  id: QaScenarioId,
  project: AgentProject,
): { connector: string; department: string; data: Row[]; generated_at: string } | null {
  if (id === "off") return null;
  return {
    connector: `QA fixture — ${id}`,
    department: "QA",
    data: buildRowsForScenario(id, project),
    generated_at: new Date().toISOString(),
  };
}
