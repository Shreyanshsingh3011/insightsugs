/**
 * Render-safe ETA formatting and duration sanity checks.
 *
 * These helpers are the last line of defence against serial-date leaks
 * (Excel numbers in the ~30k–70k range) and impossible multi-year
 * durations poisoning KPI displays like the infamous "ETA 1159d".
 */

/**
 * Reject serial-date leaks, negatives, non-finite values and impossible
 * multi-year durations so bad upstream cells can't reach TAT / ETA KPIs.
 */
export function isSaneDuration(n: number | null | undefined): n is number {
  return (
    typeof n === "number" &&
    Number.isFinite(n) &&
    n > 0 &&
    n <= 3650 &&
    !(n >= 30000 && n <= 70000)
  );
}

/**
 * Render-time guard: never let the ETA KPI display more than 365 days or
 * a serial-date leak, no matter what upstream math produced.
 *  - non-finite / <= 0            → "—"
 *  - > 365                        → "365d+"
 *  - otherwise                    → "<n>d" (rounded)
 */
export function formatEtaDays(n: number | null | undefined): string {
  if (!Number.isFinite(n as number)) return "—";
  const v = Math.round(n as number);
  if (v <= 0) return "—";
  if (v > 365) return "365d+";
  return `${v}d`;
}
