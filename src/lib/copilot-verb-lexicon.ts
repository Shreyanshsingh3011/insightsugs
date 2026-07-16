// Copilot Verb Lexicon
// Single source of truth mapping natural-language verbs/phrases to canonical
// intents. Consumed by copilot-deterministic.server.ts (routing) and
// copilot-agent.functions.ts (reasoning plan / clarification chips).
//
// Design: each entry lists surface phrases; we build a big regex with
// morphological tolerance (strip -ing/-ed/-s, collapse "break down"/"breakdown").
// detectIntent returns the strongest-matching canonical intent plus the
// residual string (question minus the verb tokens) so downstream can resolve
// column/value references from what's left.

export type CanonicalIntent =
  | "distribution"
  | "lookup"
  | "list"
  | "count"
  | "aggregate"
  | "filter"
  | "compare"
  | "trend"
  | "top"
  | "bottom"
  | "temporal"
  | "causal"
  | "summarize"
  | "predict"
  | "generic";

export interface LexiconEntry {
  intent: CanonicalIntent;
  /** Ordered by specificity — longer/more-specific phrases first for better residual stripping. */
  phrases: string[];
  /** Optional priority tiebreaker when multiple intents match. Higher wins. */
  priority?: number;
}

export const VERB_LEXICON: LexiconEntry[] = [
  {
    intent: "distribution",
    priority: 90,
    phrases: [
      "break down", "breakdown", "broken down", "breaking down", "broke down",
      "split by", "split", "group by", "grouped by", "grouping", "group",
      "distribution of", "distribution", "distribute",
      "categorize by", "categorise by", "categorize", "categorise",
      "bucket by", "bucket", "segment by", "segment",
      "pivot on", "pivot", "cross tab", "crosstab", "cross-tab",
      "frequency of", "frequency", "histogram",
      "per column", "by column", "how are ... split", "how is ... split",
    ],
  },
  {
    intent: "causal",
    priority: 88,
    phrases: [
      "why is", "why are", "why did", "why does", "why do", "why has", "why",
      "reason for", "reason", "reasons",
      "cause of", "cause", "causes",
      "what is driving", "what's driving", "driver", "drivers",
      "root cause", "root-cause", "explain", "explanation for", "explanation",
    ],
  },
  {
    intent: "compare",
    priority: 85,
    phrases: [
      "compare", "compared to", "comparison of", "comparison",
      "versus", " vs ", " vs.", "against",
      "difference between", "diff between", "diff", "delta between", "delta",
      "gap between",
    ],
  },
  {
    intent: "trend",
    priority: 82,
    phrases: [
      "trend of", "trend", "trending", "over time", "timeline of", "timeline",
      "growth of", "growth", "change in", "evolution of", "evolution",
      "monthly", "weekly", "daily", "quarterly", "yearly", "year on year", "yoy", "mom",
    ],
  },
  {
    intent: "top",
    priority: 80,
    phrases: [
      "top ", "highest", "largest", "biggest", "best", "leading", "most",
      "maximum", "max ",
    ],
  },
  {
    intent: "bottom",
    priority: 80,
    phrases: [
      "bottom ", "lowest", "smallest", "worst", "least",
      "minimum", "min ",
    ],
  },
  {
    intent: "aggregate",
    priority: 78,
    phrases: [
      "sum of", "total of", "sum", "totals", "total",
      "average of", "average", "avg", "mean of", "mean",
      "median of", "median",
      "aggregate", "rollup", "roll up",
    ],
  },
  {
    intent: "count",
    priority: 78,
    phrases: [
      "how many", "how much", "count of", "count",
      "number of", "no of", "no. of", "num of",
      "tally", "total number",
    ],
  },
  {
    intent: "temporal",
    priority: 76,
    phrases: [
      "expiring", "expires", "expire", "expired",
      "due", "overdue", "upcoming", "past due",
      "since ", "before ", "after ",
      "this week", "this month", "this quarter", "this year",
      "last week", "last month", "last quarter", "last year",
      "next week", "next month", "next quarter", "next year",
      "last ", "next ", "in the next", "in the past",
      "today", "yesterday", "tomorrow",
    ],
  },
  {
    intent: "predict",
    priority: 74,
    phrases: [
      "predict", "prediction", "forecast", "forecasting",
      "projected", "projection", "project ", "estimate", "estimated",
      "expected", "will be", "going to",
    ],
  },
  {
    intent: "summarize",
    priority: 72,
    phrases: [
      "summarize", "summarise", "summary of", "summary",
      "tldr", "tl;dr", "recap",
      "overview of", "overview",
      "give me a summary", "give me an overview",
      "highlights of", "highlights",
      "brief on", "brief",
    ],
  },
  {
    intent: "filter",
    priority: 60,
    phrases: [
      "where ", "with ", "having ", "that have", "that has",
      "only ", "matching ", "containing ", "contains ",
      "filter by", "filter",
    ],
  },
  {
    intent: "lookup",
    priority: 55,
    phrases: [
      "find ", "look up", "lookup", "pull up", "fetch ", "get ",
      "show me ", "show ", "give me ", "give ",
      "what is ", "what's ", "who is ", "who's ",
      "details of", "details for", "details",
      "info on", "information on", "info about",
      "row for", "row of", "record for", "record of",
    ],
  },
  {
    intent: "list",
    priority: 50,
    phrases: [
      "list ", "list all", "list every", "enumerate",
      "all ", "every ", "each ",
      "which ", "show all", "show every",
    ],
  },
];

// Compile once. For each entry, the regex matches ANY of its phrases.
// Phrases with a trailing space are boundary-anchored; others use \b.
const COMPILED = VERB_LEXICON.map((e) => {
  const parts = e.phrases
    .map((p) => p.trim())
    .filter(Boolean)
    // Escape regex metachars, then insert flexible whitespace between words.
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  const src = `(?:^|[^\\p{L}\\p{N}])(${parts.join("|")})(?=$|[^\\p{L}\\p{N}])`;
  return { entry: e, regex: new RegExp(src, "iu") };
});

export interface IntentDetection {
  intent: CanonicalIntent;
  matchedPhrase: string | null;
  /** All intents matched, strongest first (useful for chained intents like temporal+distribution). */
  allMatches: { intent: CanonicalIntent; phrase: string; priority: number }[];
  /** Question with the matched verb tokens removed — feed to column/value resolver. */
  residual: string;
}

/**
 * Detects the canonical intent(s) from a natural-language question.
 *
 * Multi-match: a question like "break down expiring contracts by vendor"
 * hits distribution + temporal — both surface in `allMatches`, but the
 * highest-priority one is returned as the primary `intent`.
 */
export function detectIntent(question: string): IntentDetection {
  const q = ` ${question.toLowerCase()} `;
  const matches: { intent: CanonicalIntent; phrase: string; priority: number; start: number; end: number }[] = [];
  for (const { entry, regex } of COMPILED) {
    const m = regex.exec(q);
    if (m && m[1]) {
      matches.push({
        intent: entry.intent,
        phrase: m[1].trim(),
        priority: entry.priority ?? 0,
        start: m.index + (m[0].length - m[1].length),
        end: m.index + m[0].length,
      });
    }
  }
  matches.sort((a, b) => b.priority - a.priority);
  let residual = question;
  // Strip every matched phrase from the residual (largest first).
  const sortedByLen = [...matches].sort((a, b) => b.phrase.length - a.phrase.length);
  for (const m of sortedByLen) {
    const rx = new RegExp(`\\b${m.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "iu");
    residual = residual.replace(rx, " ");
  }
  residual = residual.replace(/\s+/g, " ").trim();
  return {
    intent: matches[0]?.intent ?? "generic",
    matchedPhrase: matches[0]?.phrase ?? null,
    allMatches: matches.map(({ intent, phrase, priority }) => ({ intent, phrase, priority })),
    residual,
  };
}

/** Convenience: does the question carry ANY of the given intents? */
export function hasIntent(detection: IntentDetection, ...wanted: CanonicalIntent[]): boolean {
  const set = new Set(wanted);
  return detection.allMatches.some((m) => set.has(m.intent));
}
