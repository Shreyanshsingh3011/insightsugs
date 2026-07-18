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
      "split by", "split up", "split", "group by", "grouped by", "grouping", "group",
      "distribution of", "distribution", "distribute", "distributed",
      "categorize by", "categorise by", "categorize", "categorise", "categorized", "categorised",
      "classify", "classified", "classification of", "classification",
      "bucket by", "bucket", "buckets", "segment by", "segment", "segmented",
      "pivot on", "pivot", "cross tab", "crosstab", "cross-tab",
      "frequency of", "frequency", "histogram",
      "per column", "by column", "how are ... split", "how is ... split",
      "map by", "mapped by", "chart by", "plot by",
    ],
  },
  {
    intent: "causal",
    priority: 88,
    phrases: [
      "why is", "why are", "why did", "why does", "why do", "why has", "why haven't", "why havent", "why",
      "reason for", "reason", "reasons",
      "cause of", "cause", "causes",
      "what is driving", "what's driving", "whats driving", "driver", "drivers",
      "root cause", "root-cause", "explain", "explanation for", "explanation",
      "diagnose", "diagnosis of", "diagnosis", "troubleshoot",
      "what caused", "what led to", "led to", "resulted in",
    ],
  },
  {
    intent: "compare",
    priority: 85,
    phrases: [
      "compare", "compares", "compared", "comparing", "compared to", "compared with",
      "comparison of", "comparison", "comparisons",
      "versus", " vs ", " vs.", "against",
      "difference between", "differences between", "diff between", "diff", "delta between", "delta",
      "gap between", "gap", "variance between", "variance",
      "benchmark", "benchmarked", "benchmarking",
      "side by side", "side-by-side",
      "who's better", "which is better", "which is faster", "which is slower",
      "correlate", "correlated", "correlation between", "correlation",
      "relate", "related to", "relationship between", "relationship",
    ],
  },
  {
    intent: "trend",
    priority: 82,
    phrases: [
      "trend of", "trend", "trends", "trending", "over time", "timeline of", "timeline",
      "growth of", "growth", "change in", "changes in", "evolution of", "evolution",
      "monthly", "weekly", "daily", "quarterly", "yearly", "year on year", "yoy", "mom", "wow",
      "history of", "historical", "progression of", "progression",
      "track", "tracking", "tracked",
    ],
  },
  {
    intent: "top",
    priority: 80,
    phrases: [
      "top ", "highest", "largest", "biggest", "best", "leading", "most",
      "maximum", "max ", "peak", "greatest",
      "rank", "ranked", "ranking of", "ranking",
      "rate top", "leaderboard",
    ],
  },
  {
    intent: "bottom",
    priority: 80,
    phrases: [
      "bottom ", "lowest", "smallest", "worst", "least", "poorest",
      "minimum", "min ", "trailing",
    ],
  },
  {
    intent: "aggregate",
    priority: 78,
    phrases: [
      "sum of", "total of", "sum", "totals", "total", "totalled", "totaled",
      "average of", "average", "avg", "mean of", "mean",
      "median of", "median",
      "aggregate", "aggregated", "rollup", "roll up", "rolled up",
      "calculate", "calculated", "compute", "computed", "derive", "derived", "work out",
      "add up", "added up",
    ],
  },
  {
    intent: "count",
    priority: 78,
    phrases: [
      "how many", "how much", "count of", "count", "counts", "counted",
      "number of", "no of", "no. of", "num of",
      "tally", "tallied", "total number",
    ],
  },
  {
    intent: "temporal",
    priority: 76,
    phrases: [
      "expiring", "expires", "expire", "expired",
      "due", "overdue", "upcoming", "past due", "past-due",
      "since ", "before ", "after ",
      "this week", "this month", "this quarter", "this year",
      "last week", "last month", "last quarter", "last year",
      "next week", "next month", "next quarter", "next year",
      "last ", "next ", "in the next", "in the past",
      "today", "yesterday", "tomorrow",
      "recent", "recently", "latest", "earliest",
    ],
  },
  {
    intent: "predict",
    priority: 74,
    phrases: [
      "predict", "prediction", "forecast", "forecasted", "forecasting",
      "projected", "projection", "project ", "estimate", "estimated", "estimation",
      "expected", "will be", "going to", "likely to",
      "extrapolate", "extrapolated",
    ],
  },
  {
    intent: "summarize",
    priority: 72,
    phrases: [
      "summarize", "summarise", "summarized", "summarised", "summary of", "summary",
      "tldr", "tl;dr", "recap", "recaps",
      "overview of", "overview",
      "give me a summary", "give me an overview",
      "highlights of", "highlights",
      "brief on", "brief", "briefing on", "briefing",
      "describe", "description of", "description",
      "tell me about", "tell me", "walk me through", "walk through",
      "gist of", "gist",
      "report on", "report",
    ],
  },
  {
    intent: "filter",
    priority: 60,
    phrases: [
      "where ", "with ", "having ", "that have", "that has", "that are", "that is",
      "only ", "matching ", "containing ", "contains ", "contain ",
      "filter by", "filter", "filtered", "filtering",
      "exclude", "excluding", "excluded", "except ", "excepting",
      "include", "including", "included",
      "restrict to", "restricted to", "limited to", "limit to",
      "narrow to", "narrow down",
      "ignore", "ignoring", "skip", "skipping",
      "sort by", "sorted by", "order by", "ordered by", "arrange by", "arranged by",
    ],
  },
  {
    intent: "lookup",
    priority: 55,
    phrases: [
      "find ", "finds ", "finding ", "found ",
      "look up", "looked up", "lookup", "look for", "looking for",
      "pull up", "pulled up", "pull ", "fetch ", "fetched",
      "get ", "grab ", "retrieve", "retrieved",
      "show me ", "show ", "showing ", "display ", "displays ", "displayed", "present ",
      "give me ", "give ",
      "what is ", "what's ", "whats ", "who is ", "who's ", "whos ", "where is ", "where's ",
      "details of", "details for", "details on", "details about", "details",
      "info on", "info about", "info for", "information on", "information about", "information for",
      "row for", "row of", "record for", "record of", "records for", "records of",
      "identify", "identified", "spot", "detect", "detected",
      "check ", "checks ", "checked ", "checking ", "verify", "verified", "validate", "validated", "confirm", "confirmed",
      "review", "reviewed", "reviewing", "inspect", "inspected", "examine", "examined", "audit", "audited",
      "see ", "view ", "viewed ", "viewing ",
      "open ", "opened ",
    ],
  },
  {
    intent: "list",
    priority: 50,
    phrases: [
      "list ", "list all", "list every", "list out", "enumerate", "enumerated",
      "all ", "every ", "each ",
      "which ", "show all", "show every",
      "pick ", "choose ", "select ",
      "suggest", "suggested", "recommend", "recommended", "propose", "proposed",
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
