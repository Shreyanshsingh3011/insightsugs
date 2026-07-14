// PostgREST/`ilike` treats `%` and `_` as wildcards, and `\` as an escape.
// User-controlled email/name strings passed into `.ilike(col, value)` without
// escaping let a caller broaden the match (e.g. `a%@corp.com` matches every
// address at the domain). Escape wildcards so an `ilike` behaves as a
// case-insensitive equality check.
export function escapeIlike(value: string): string {
  return String(value ?? "").replace(/[\\%_]/g, (m) => `\\${m}`);
}

// Convenience for the common "case-insensitive exact email match" pattern.
// Trims and lowercases first so we don't miss rows that were stored with
// canonical casing on insert.
export function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}
