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
