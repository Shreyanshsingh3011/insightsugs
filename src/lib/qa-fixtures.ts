// QA data fixtures — synthetic sheet payloads for reproducing edge-case bugs.
// Activated via the QaDataSwitcher UI (localStorage `qa:scenario`). When a
// scenario is active, useAgentSources swaps live sheet rows for these before
// person-decoration/scoping — so every downstream page (dashboard, alerts,
// project health, KPI drilldowns, briefings, agent inbox) sees the fixture.

import type { Row } from "@/lib/entity-scope";
import type { AgentProject } from "@/lib/agent-registry.functions";

export type QaScenarioId =
  | "off"
  | "demo"
  | "empty"
  | "single"
  | "many-alerts"
  | "long-list"
  | "no-delays"
  | "date-serial-leak"
  | "missing-owners";

export const QA_SCENARIOS: { id: QaScenarioId; label: string; description: string }[] = [
  { id: "off",              label: "Live data (auto-demo)", description: "Use real sheets. Falls back to demo data automatically when every sheet returns 0 rows." },
  { id: "demo",             label: "Demo dataset (full)",   description: "Realistic multi-project workflow data. Every feature testable: alerts, KPIs, stages, owners, briefings, copilot." },
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

// ---------------------------------------------------------------------------
// Demo dataset — realistic tender-to-handover workflow per project so every
// feature (alerts, KPIs, stage bottlenecks, owner pages, correlations,
// briefings, copilot citations) has meaningful data to work with while the
// live Google Sheets are permission-blocked.
// ---------------------------------------------------------------------------

type DemoSpec = { stage: string; activity: string; desc: string; tat: number; delay: number; status: string; owner: number; dept: string };

const DEMO_TEMPLATE: DemoSpec[] = [
  { stage: "Pre-Tender", activity: "Tender document collection",        desc: "Download and compile the complete NIT / bid document set.",        tat: 5,  delay: 0,  status: "Completed",   owner: 0, dept: "Ops" },
  { stage: "Pre-Tender", activity: "Eligibility & scope study",         desc: "Assess technical and financial eligibility against the NIT.",       tat: 7,  delay: 0,  status: "Completed",   owner: 1, dept: "Engg" },
  { stage: "Pre-Tender", activity: "Site visit & survey report",        desc: "Physical site survey and photographic survey report.",              tat: 10, delay: 12, status: "In Progress", owner: 2, dept: "Engg" },
  { stage: "Pre-Tender", activity: "Vendor quotation collection",       desc: "Collect at least three quotations for major BOQ items.",            tat: 8,  delay: 6,  status: "In Progress", owner: 3, dept: "Ops" },
  { stage: "Tender",     activity: "BOQ & rate analysis",               desc: "Prepare BOQ, rate analysis and overhead loading.",                  tat: 6,  delay: 0,  status: "Completed",   owner: 1, dept: "Finance" },
  { stage: "Tender",     activity: "EMD / bank guarantee processing",   desc: "Arrange EMD instrument and confirm validity period.",               tat: 4,  delay: 3,  status: "In Progress", owner: 4, dept: "Finance" },
  { stage: "Tender",     activity: "Technical bid preparation",         desc: "Compile technical bid annexures and compliance sheet.",             tat: 9,  delay: 0,  status: "Completed",   owner: 0, dept: "Engg" },
  { stage: "Tender",     activity: "Bid submission on portal",          desc: "Upload and freeze bid on the e-procurement portal.",                tat: 2,  delay: 0,  status: "Completed",   owner: 2, dept: "Ops" },
  { stage: "Pre-Award",  activity: "Technical clarification replies",   desc: "Respond to department queries within the stipulated window.",       tat: 5,  delay: 9,  status: "In Progress", owner: 3, dept: "Engg" },
  { stage: "Pre-Award",  activity: "Price bid opening follow-up",       desc: "Track price-bid opening schedule and comparative statement.",       tat: 3,  delay: 0,  status: "Completed",   owner: 1, dept: "Ops" },
  { stage: "Award",      activity: "LOI / work order acceptance",       desc: "Review and formally accept the letter of intent.",                  tat: 4,  delay: 0,  status: "Completed",   owner: 4, dept: "Legal" },
  { stage: "Award",      activity: "Performance BG submission",         desc: "Submit performance bank guarantee to the client.",                  tat: 7,  delay: 14, status: "In Progress", owner: 4, dept: "Finance" },
  { stage: "Award",      activity: "Agreement signing",                 desc: "Execute the contract agreement with stamp duty.",                   tat: 6,  delay: 0,  status: "Not Started", owner: 0, dept: "Legal" },
  { stage: "Execution",  activity: "Mobilisation & site setup",         desc: "Mobilise manpower, machinery and site office.",                     tat: 12, delay: 0,  status: "In Progress", owner: 2, dept: "Ops" },
  { stage: "Execution",  activity: "Material procurement schedule",     desc: "Release purchase orders per the approved procurement plan.",        tat: 15, delay: 21, status: "In Progress", owner: 3, dept: "Ops" },
  { stage: "Execution",  activity: "Monthly progress billing",          desc: "Raise RA bill with measurement sheets and client sign-off.",        tat: 8,  delay: 4,  status: "In Progress", owner: 1, dept: "Finance" },
  { stage: "Execution",  activity: "Quality inspection & testing",      desc: "Third-party inspection and test certificate collection.",           tat: 10, delay: 0,  status: "Not Started", owner: 2, dept: "Engg" },
  { stage: "Handover",   activity: "As-built drawings submission",      desc: "Submit as-built drawings and O&M manuals.",                         tat: 9,  delay: 0,  status: "Not Started", owner: 0, dept: "Engg" },
  { stage: "Handover",   activity: "Final bill & retention release",    desc: "Submit final bill and follow up on retention money release.",       tat: 14, delay: 0,  status: "Not Started", owner: 4, dept: "Finance" },
  { stage: "Handover",   activity: "Defect liability closure",          desc: "Close out defect liability period and obtain completion cert.",     tat: 20, delay: 0,  status: "Not Started", owner: 1, dept: "Legal" },
];

/** Deterministic per-project variation so each source looks distinct. */
function demoSeed(projectId: string): number {
  let h = 0;
  for (const ch of projectId) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

function buildDemoRows(project: AgentProject): Row[] {
  const seed = demoSeed(project.id);
  return DEMO_TEMPLATE.map((spec, i) => {
    // Vary delay/status slightly per project so KPIs and bottlenecks differ.
    const bump = (seed + i * 7) % 5;
    const delay = spec.delay > 0 ? spec.delay + bump : (bump === 4 ? 2 + bump : 0);
    const status = delay > 0 && spec.status === "Completed" ? "In Progress" : spec.status;
    const started = status !== "Not Started";
    const tat = spec.tat + (bump % 3);
    const taken = !started ? "" : status === "Completed" ? Math.max(1, tat - (bump % 3)) : tat + delay;
    const plannedStart = daysAgoISO(70 - i * 2);
    const plannedEnd = daysAgoISO(70 - i * 2 - tat);
    return {
      "Sr. No.": i + 1,
      "Stages": spec.stage,
      "Stages of Process": spec.stage,
      "Activity List": spec.activity,
      "Process Descriptions": spec.desc,
      "Responsible Person": OWNERS[(spec.owner + seed) % OWNERS.length].name,
      "Responsible Person Mail ID": OWNERS[(spec.owner + seed) % OWNERS.length].email,
      "Department": spec.dept,
      "Planned Start Date": plannedStart,
      "Planned Completion Date": plannedEnd,
      "Actual Start Date": started ? plannedStart : "",
      "Actual Completion Date": status === "Completed" ? daysAgoISO(70 - i * 2 - tat - 1) : "",
      "TAT": tat,
      "Days Taken": taken,
      "Delay (In Days)": delay,
      "Status": status,
      "Remarks": delay > 0 ? "Pending client / vendor response" : "",
    } as Row;
  });
}

function buildRowsForScenario(id: QaScenarioId, project: AgentProject): Row[] {
  switch (id) {
    case "demo":
      return buildDemoRows(project);

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
    connector: id === "demo" ? "Demo dataset (sheets unavailable)" : `QA fixture — ${id}`,
    department: id === "demo" ? "Projects" : "QA",
    data: buildRowsForScenario(id, project),
    generated_at: new Date().toISOString(),
  };

}
