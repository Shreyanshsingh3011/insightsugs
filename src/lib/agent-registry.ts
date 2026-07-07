// Static registry of specialist agents. Client-safe.
export type AgentSpec = {
  key: string;
  name: string;
  purpose: string;
  toolAllowList: string[];
  temperature?: number;
};

const READ_TOOLS = [
  "getDashboardSummary",
  "getPersonWorkload",
  "topDelays",
  "filterActivities",
  "getOpenAlerts",
  "queryProjects",
  "investigateDelay",
  "summarizeThread",
  "generateStatusReport",
];

const WRITE_TOOLS = [
  "proposeCreateAlert",
  "proposeNudgeAssignee",
  "createAlert",
  "draftEmail",
  "scheduleStandup",
];

export const AGENT_REGISTRY: Record<string, AgentSpec> = {
  analyst: {
    key: "analyst",
    name: "Analyst",
    purpose: "Read-only insights and root-cause investigation across projects.",
    toolAllowList: READ_TOOLS,
  },
  scheduler: {
    key: "scheduler",
    name: "Scheduler",
    purpose:
      "Investigates delays and proposes alerts, nudges, emails, and standups (human approval required).",
    toolAllowList: [...READ_TOOLS, ...WRITE_TOOLS],
  },
  memory: {
    key: "memory",
    name: "Memory",
    purpose: "Recalls and stores durable user preferences and facts.",
    toolAllowList: ["rememberFact"],
  },
};

const KEYWORD_ROUTES: Array<{ agent: keyof typeof AGENT_REGISTRY; patterns: RegExp[] }> = [
  {
    agent: "scheduler",
    patterns: [
      /\bnudge\b/i,
      /\bping\b/i,
      /\bflag\b/i,
      /\balert\b/i,
      /\bremind\b/i,
      /\bfollow ?up\b/i,
      /\bescalat/i,
      /\bemail\b/i,
      /\bstandup\b/i,
      /\bmeeting\b/i,
      /\bschedule\b/i,
      /\bwhy is\b.*\b(late|delayed|behind|slipping)\b/i,
      /\bwho should i\b/i,
    ],
  },
  {
    agent: "memory",
    patterns: [/\bremember\b/i, /\bforget\b/i, /\bmy preference/i, /\bnote that\b/i],
  },
];

export function routeToAgent(userText: string): keyof typeof AGENT_REGISTRY {
  for (const rule of KEYWORD_ROUTES) {
    if (rule.patterns.some((rx) => rx.test(userText))) return rule.agent;
  }
  return "analyst";
}
