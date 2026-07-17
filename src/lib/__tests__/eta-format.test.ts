import { describe, it, expect } from "bun:test";
import { formatEtaDays, isSaneDuration } from "@/lib/eta-format";
import { sanitizeDuration } from "@/lib/status-utils";

/**
 * Regression suite for the "ETA 1159d" family of bugs. If any of these
 * assertions fail, a serial-date leak or unclamped multi-year projection
 * can reach the KPI again — do not weaken the bounds without updating the
 * dashboard render layer at the same time.
 */

describe("sanitizeDuration (status-utils)", () => {
  it("passes through normal durations", () => {
    expect(sanitizeDuration(0)).toBe(0);
    expect(sanitizeDuration(1)).toBe(1);
    expect(sanitizeDuration(180)).toBe(180);
    expect(sanitizeDuration(3650)).toBe(3650);
  });

  it("rejects negatives and non-finite values", () => {
    expect(sanitizeDuration(-1)).toBe(0);
    expect(sanitizeDuration(-9999)).toBe(0);
    expect(sanitizeDuration(NaN)).toBe(0);
    expect(sanitizeDuration(Infinity)).toBe(0);
    expect(sanitizeDuration(-Infinity)).toBe(0);
  });

  it("rejects impossible multi-year durations (> 3650d)", () => {
    expect(sanitizeDuration(3651)).toBe(0);
    expect(sanitizeDuration(10_000)).toBe(0);
  });

  it("rejects Excel/Sheets serial-date leaks in the 30k–70k band", () => {
    // Google Sheets serial for 2022-01-01 ≈ 44562, 2025-01-01 ≈ 45658.
    // The infamous "1159d" bug was traced to unclamped serials of this shape.
    expect(sanitizeDuration(30_000)).toBe(0);
    expect(sanitizeDuration(44_562)).toBe(0);
    expect(sanitizeDuration(45_658)).toBe(0);
    expect(sanitizeDuration(46_000)).toBe(0);
    expect(sanitizeDuration(70_000)).toBe(0);
  });
});

describe("isSaneDuration (feed guard)", () => {
  it("accepts strictly positive, finite, sub-decade values", () => {
    expect(isSaneDuration(1)).toBe(true);
    expect(isSaneDuration(365)).toBe(true);
    expect(isSaneDuration(3650)).toBe(true);
  });

  it("rejects zero, negatives, null/undefined, non-numbers", () => {
    expect(isSaneDuration(0)).toBe(false);
    expect(isSaneDuration(-1)).toBe(false);
    expect(isSaneDuration(null)).toBe(false);
    expect(isSaneDuration(undefined)).toBe(false);
    // @ts-expect-error — runtime robustness
    expect(isSaneDuration("42")).toBe(false);
    expect(isSaneDuration(NaN)).toBe(false);
    expect(isSaneDuration(Infinity)).toBe(false);
  });

  it("rejects serial-date leaks and > 3650 outliers", () => {
    expect(isSaneDuration(3651)).toBe(false);
    expect(isSaneDuration(30_000)).toBe(false);
    expect(isSaneDuration(45_658)).toBe(false);
    expect(isSaneDuration(70_000)).toBe(false);
  });
});

describe("formatEtaDays (render-time guard)", () => {
  it("formats normal projections as '<n>d'", () => {
    expect(formatEtaDays(1)).toBe("1d");
    expect(formatEtaDays(42)).toBe("42d");
    expect(formatEtaDays(365)).toBe("365d");
  });

  it("rounds fractional values to the nearest whole day", () => {
    expect(formatEtaDays(41.4)).toBe("41d");
    expect(formatEtaDays(41.6)).toBe("42d");
    expect(formatEtaDays(0.4)).toBe("—");
    expect(formatEtaDays(0.6)).toBe("1d");
  });

  it("renders '—' for non-finite, null/undefined and <= 0 values", () => {
    expect(formatEtaDays(null)).toBe("—");
    expect(formatEtaDays(undefined)).toBe("—");
    expect(formatEtaDays(NaN)).toBe("—");
    expect(formatEtaDays(Infinity)).toBe("—");
    expect(formatEtaDays(-Infinity)).toBe("—");
    expect(formatEtaDays(0)).toBe("—");
    expect(formatEtaDays(-5)).toBe("—");
  });

  it("collapses anything above 365 days to '365d+' — the 1159d regression guard", () => {
    expect(formatEtaDays(366)).toBe("365d+");
    expect(formatEtaDays(1159)).toBe("365d+");
    expect(formatEtaDays(9999)).toBe("365d+");
    // Serial-date leak escaping upstream sanitization must still not render as days.
    expect(formatEtaDays(45_658)).toBe("365d+");
  });
});
