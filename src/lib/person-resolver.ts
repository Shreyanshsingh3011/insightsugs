// Resolve "who is the person on this row?" — because the source sheet's
// Responsible Person / approvers name columns are frequently filled with
// job titles (e.g. "Project Manager", "Vertical Head") instead of an actual
// human. We prefer, in order:
//   1. A dedicated name column (Owner Name / Assignee / Assigned To) if it
//      contains a name-like value.
//   2. `approvers name` / `Responsible Person` / `Responsibility` if that
//      value looks like a real name (not a title).
//   3. `profiles.full_name` looked up by the `Responsible Person Mail ID`
//      (or `approvers email id`).
//   4. The email local-part (`arpita.d@x → Arpita D`).
//   5. The raw role/title string as a last-resort label.

const TITLE_KEYWORDS = [
  "manager","md","ceo","cto","cfo","coo","vp","gm","dgm","agm","avp","evp",
  "president","director","head","lead","officer","engineer","architect",
  "coordinator","consultant","analyst","auditor","secretary","admin",
  "administrator","supervisor","planner","reviewer","approver","approvers",
  "vertical","reporting","project","assistant","associate","executive",
  "designer","developer","specialist","superintendent","incharge","in-charge",
  "operator","controller","accountant","team","department","dept","division",
  "site","field","office","support","member","staff","personnel","owner",
  "responsibility","responsible person","the responsible person",
];

const TITLE_REGEX = new RegExp(
  `\\b(?:${TITLE_KEYWORDS.map((k) => k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")})\\b`,
  "i",
);

/** Cheap heuristic: does this string look like a job title or generic role? */
export function looksLikeTitle(s: string): boolean {
  const v = (s || "").trim();
  if (!v) return true;
  if (v.length < 3) return true;
  // Long descriptors like "Project Manager - Civil (South Region)" count as titles.
  return TITLE_REGEX.test(v);
}

/** Cheap heuristic: does this string look like a real human name? */
export function looksLikeRealName(s: string): boolean {
  const v = (s || "").trim();
  if (!v) return false;
  if (v.length < 3) return false;
  if (/@/.test(v)) return false;                       // it's an email, not a name
  if (looksLikeTitle(v)) return false;
  // Must have at least one letter, and either a space between two
  // capitalized-ish tokens OR a single capitalized token ≥ 3 chars.
  const tokens = v.split(/\s+/).filter(Boolean);
  const hasLetter = /[a-zA-Z]/.test(v);
  if (!hasLetter) return false;
  if (tokens.length >= 2) {
    const capTokens = tokens.filter((t) => /^[A-Za-z][a-zA-Z.'-]*$/.test(t));
    return capTokens.length >= 2;
  }
  return /^[A-Za-z][a-zA-Z.'-]{2,}$/.test(tokens[0]);
}

/** Turn "arpita.das" or "arpita_das" into "Arpita Das". */
export function humanizeEmailLocal(email: string): string {
  const local = (email || "").split("@")[0] || "";
  if (!local) return "";
  return local
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map((p) => p.replace(/\d+$/, ""))
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

export type ResolveInput = {
  raw?: string;   // Responsible Person / Responsibility / approvers name (may be a title)
  alt?: string;   // Owner Name / Assignee / Assigned To
  email?: string; // Responsible Person Mail ID / approvers email id (already lowercased)
};

export type PersonResolution = {
  /** Stable key used for grouping (lowercased email if present, else lowercased displayName). */
  key: string;
  /** Human-friendly label shown in the UI. */
  displayName: string;
  /** Email attached to this person, if any. */
  email: string;
  /** Which field the display name came from. */
  source: "alt-column" | "raw-name" | "profile" | "email-local" | "role-fallback" | "unassigned";
  /** True when we had to fall back to the role/title column because no better source was found. */
  isTitleFallback: boolean;
  /** The original role/title string (kept for debugging + tooltips). */
  roleTitle: string;
};

/** Directory of email (lowercased) → profile full_name. */
export type ProfileDirectory = Map<string, string>;

export function resolvePerson(
  input: ResolveInput,
  directory?: ProfileDirectory,
): PersonResolution {
  const raw = (input.raw ?? "").trim();
  const alt = (input.alt ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const roleTitle = raw && looksLikeTitle(raw) ? raw : "";

  // 1. Real name column wins.
  if (alt && looksLikeRealName(alt)) {
    return {
      key: (email || alt).toLowerCase(),
      displayName: alt,
      email,
      source: "alt-column",
      isTitleFallback: false,
      roleTitle,
    };
  }

  // 2. Raw column, only if it looks like a name.
  if (raw && looksLikeRealName(raw)) {
    return {
      key: (email || raw).toLowerCase(),
      displayName: raw,
      email,
      source: "raw-name",
      isTitleFallback: false,
      roleTitle,
    };
  }

  // 3. Profile lookup by email.
  if (email && directory) {
    const hit = directory.get(email);
    if (hit && hit.trim()) {
      return {
        key: email,
        displayName: hit.trim(),
        email,
        source: "profile",
        isTitleFallback: false,
        roleTitle,
      };
    }
  }

  // 4. Humanise email local-part.
  if (email) {
    const guess = humanizeEmailLocal(email);
    if (guess) {
      return {
        key: email,
        displayName: guess,
        email,
        source: "email-local",
        isTitleFallback: false,
        roleTitle,
      };
    }
  }

  // 5. Fall back to the raw role string.
  if (raw) {
    return {
      key: raw.toLowerCase(),
      displayName: raw,
      email,
      source: "role-fallback",
      isTitleFallback: true,
      roleTitle: raw,
    };
  }

  return {
    key: "unassigned",
    displayName: "Unassigned",
    email,
    source: "unassigned",
    isTitleFallback: false,
    roleTitle: "",
  };
}

/** Extract the resolver input triple from a raw sheet row. */
export function resolveInputFromRow(r: Record<string, unknown>): ResolveInput {
  const val = (...keys: string[]) => {
    for (const k of keys) {
      const v = r[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    }
    return "";
  };
  return {
    raw: val("Responsible Person", "Responsibility", "approvers name"),
    alt: val("Owner Name", "Assignee", "Assigned To", "Owner"),
    email: val("Responsible Person Mail ID", "approvers email id").toLowerCase(),
  };
}

export function resolvePersonForRow(
  r: Record<string, unknown>,
  directory?: ProfileDirectory,
): PersonResolution {
  return resolvePerson(resolveInputFromRow(r), directory);
}

// ─────────────── Fuzzy name matching ───────────────
// Loose fallback for when strict matching misses variants ("Arpita D" vs
// "Arpita Das", "Manka Bibi" vs "Munka Bibi", initials, extra dots).

function normName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Classic Levenshtein distance. Small strings only — O(n*m). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/** Similarity ratio 0..1 (1 = identical). */
export function nameSimilarity(a: string, b: string): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  const dist = levenshtein(x, y);
  const max = Math.max(x.length, y.length);
  return max === 0 ? 1 : 1 - dist / max;
}

/** True if the two names are close enough to be the same person. */
export function fuzzyNameMatch(a: string, b: string, threshold = 0.82): boolean {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Token subset: "arpita" matches "arpita das".
  const xt = new Set(x.split(" "));
  const yt = new Set(y.split(" "));
  let shared = 0;
  for (const t of xt) if (yt.has(t) && t.length >= 3) shared++;
  const minTokens = Math.min(xt.size, yt.size);
  if (minTokens > 0 && shared / minTokens >= 0.5 && shared >= 1) return true;
  return nameSimilarity(x, y) >= threshold;
}

/** Best-matching candidate name for a free-text query, or null. */
export function bestFuzzyName(
  query: string,
  candidates: Iterable<string>,
  threshold = 0.82,
): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const c of candidates) {
    const s = nameSimilarity(query, c);
    if (s >= threshold && (!best || s > best.score)) best = { name: c, score: s };
  }
  return best;
}

/**
 * Does the haystack contain a token window that fuzzy-matches `name`?
 * Scans 1–3 word windows to catch "Arpita Das" appearing inside a longer
 * cell value.
 */
export function fuzzyNameInText(name: string, hay: string, threshold = 0.85): boolean {
  const n = normName(name);
  if (!n) return false;
  const h = normName(hay);
  if (!h) return false;
  if (h.includes(n)) return true;
  const words = h.split(" ");
  const target = n.split(" ").length;
  const spans = [target, Math.max(1, target - 1), target + 1].filter((w) => w >= 1);
  for (const span of spans) {
    for (let i = 0; i + span <= words.length; i++) {
      const window = words.slice(i, i + span).join(" ");
      if (nameSimilarity(window, n) >= threshold) return true;
    }
  }
  return false;
}
