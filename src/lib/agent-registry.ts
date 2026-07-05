// Static registry of specialist agents (Step 5). Client-safe.
export type AgentSpec = {
  key: string;
  name: string;
  purpose: string;
  toolAllowList: string[];
  temperature?: number;
};

export const AGENT_REGISTRY: Record<string, AgentSpec> = {
  analyst: {
    key: "analyst",
    name: "Analyst",
    purpose: "Read-only insights: summaries, top delays, workload, alerts.",
    toolAllowList: [
      "getDashboardSummary",
      "getPersonWorkload",
      "topDelays",
      "filterActivities",
      "getOpenAlerts",
    ],
  },
  scheduler: {
    key: "scheduler",
    name: "Scheduler",
    purpose: "Proposes alerts and nudges (human approval required).",
    toolAllowList: [
      "getOpenAlerts",
      "getPersonWorkload",
      "topDelays",
      "proposeCreateAlert",
      "proposeNudgeAssignee",
    ],
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
    patterns: [/\bnudge\b/i, /\bping\b/i, /\bflag\b/i, /\balert\b/i, /\bremind\b/i, /\bfollow ?up\b/i, /\bescalat/i],
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
