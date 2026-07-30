import { describe, it, expect } from "vitest";
import {
  encodeRowKey,
  decodeRowKey,
  rowIdent,
  rowMatchesIdent,
  type Row,
  type RowIdent,
} from "@/lib/entity-scope";

/**
 * Regression tests for the normalized + contains-match row matching used by
 * every dashboard card (Overdue, Delayed, Anomalies, Not started, direct row
 * links). The prior strict-equality implementation broke deep-links whenever
 * a sheet value drifted by whitespace, punctuation, casing, or a leading zero.
 */

function mkRow(over: Partial<Record<string, unknown>> = {}): Row {
  return {
    "__project": "Himachal",
    "Sr. No.": "12",
    "Activity List": "Site Survey",
    ...over,
  };
}

const baseIdent: RowIdent = {
  project: "Himachal",
  srNo: "12",
  activity: "Site Survey",
};

describe("rowMatchesIdent — happy paths", () => {
  it("matches exact project + Sr. No.", () => {
    expect(rowMatchesIdent(mkRow(), baseIdent)).toBe(true);
  });

  it("matches via projectLabel override when row has no __project", () => {
    const r = mkRow({ __project: "" });
    expect(rowMatchesIdent(r, baseIdent, "Himachal")).toBe(true);
  });

  it("matches via activity when Sr. No. is missing in ident", () => {
    expect(
      rowMatchesIdent(mkRow(), { project: "Himachal", srNo: "", activity: "Site Survey" }),
    ).toBe(true);
  });
});

describe("rowMatchesIdent — normalized project drift", () => {
  it("case-insensitive project match", () => {
    expect(rowMatchesIdent(mkRow({ __project: "HIMACHAL" }), baseIdent)).toBe(true);
  });

  it("whitespace/punctuation drift on project (e.g. 'Himachal ' vs 'Himachal')", () => {
    expect(rowMatchesIdent(mkRow({ __project: "  Himachal " }), baseIdent)).toBe(true);
    expect(rowMatchesIdent(mkRow({ __project: "Himachal-Pradesh" }), { ...baseIdent, project: "Himachal Pradesh" })).toBe(true);
  });

  it("contains-match: ident 'Himachal' resolves against row 'Himachal Pradesh'", () => {
    expect(
      rowMatchesIdent(mkRow({ __project: "Himachal Pradesh" }), { ...baseIdent, project: "Himachal" }),
    ).toBe(true);
  });

  it("contains-match reverse: ident 'Himachal Pradesh' resolves against row 'Himachal'", () => {
    expect(
      rowMatchesIdent(mkRow({ __project: "Himachal" }), { ...baseIdent, project: "Himachal Pradesh" }),
    ).toBe(true);
  });

  it("different projects with no substring overlap must NOT match", () => {
    expect(rowMatchesIdent(mkRow({ __project: "PSPCL" }), baseIdent)).toBe(false);
  });
});

describe("rowMatchesIdent — Sr. No. tolerance", () => {
  it("ignores leading zeros ('012' == '12')", () => {
    expect(rowMatchesIdent(mkRow({ "Sr. No.": "012" }), baseIdent)).toBe(true);
    expect(rowMatchesIdent(mkRow(), { ...baseIdent, srNo: "0012" })).toBe(true);
  });

  it("trims whitespace around Sr. No.", () => {
    expect(rowMatchesIdent(mkRow({ "Sr. No.": " 12 " }), baseIdent)).toBe(true);
  });

  it("distinct Sr. No. values do not collide", () => {
    expect(rowMatchesIdent(mkRow({ "Sr. No.": "13" }), baseIdent)).toBe(false);
  });

  it("requires activity to match when Sr. No. repeats in a project", () => {
    const firstRepeated = mkRow({ "Sr. No.": "44", "Activity List": "Survey approval" });
    const clicked = { project: "Himachal", srNo: "44", activity: "BOQ approval" };
    expect(rowMatchesIdent(firstRepeated, clicked)).toBe(false);
    expect(rowMatchesIdent(mkRow({ "Sr. No.": "44", "Activity List": "BOQ approval" }), clicked)).toBe(true);
  });
});

describe("rowMatchesIdent — activity fallback", () => {
  it("normalizes activity punctuation/case/whitespace", () => {
    const r = mkRow({ "Sr. No.": "", "Activity List": "  site-survey  " });
    expect(
      rowMatchesIdent(r, { project: "Himachal", srNo: "", activity: "Site Survey" }),
    ).toBe(true);
  });

  it("contains-match on activity ('Survey' resolves 'Site Survey Round 1')", () => {
    const r = mkRow({ "Sr. No.": "", "Activity List": "Site Survey Round 1" });
    expect(
      rowMatchesIdent(r, { project: "Himachal", srNo: "", activity: "Site Survey" }),
    ).toBe(true);
  });

  it("returns false when both Sr. No. and activity are empty in ident", () => {
    expect(
      rowMatchesIdent(mkRow(), { project: "Himachal", srNo: "", activity: "" }),
    ).toBe(false);
  });

  it("uses activity fallback aliases (Process Descriptions)", () => {
    const r: Row = { "__project": "Bihar", "Process Descriptions": "Kickoff" };
    expect(
      rowMatchesIdent(r, { project: "Bihar", srNo: "", activity: "Kickoff" }),
    ).toBe(true);
  });

  it("falls back to activity when the URL has no Sr. No. but the row does", () => {
    expect(
      rowMatchesIdent(mkRow({ "Sr. No.": "15", "Activity List": "Route survey" }), {
        project: "Himachal",
        srNo: "",
        activity: "Route survey",
      }),
    ).toBe(true);
  });
});

describe("encodeRowKey / decodeRowKey round trip", () => {
  it("round-trips a typical ident", () => {
    const key = encodeRowKey(baseIdent);
    expect(decodeRowKey(key)).toEqual(baseIdent);
  });

  it("preserves '::' inside activity names", () => {
    const ident: RowIdent = {
      project: "PSPCL",
      srNo: "7",
      activity: "Handover :: Phase 2",
    };
    const key = encodeRowKey(ident);
    expect(decodeRowKey(key)).toEqual(ident);
  });

  it("dashboard card deep-link: encode from live row, decode, match same row", () => {
    const row = mkRow({ __project: "Himachal Pradesh", "Sr. No.": "045" });
    const ident = rowIdent(row);
    const decoded = decodeRowKey(encodeRowKey(ident));
    expect(rowMatchesIdent(row, decoded)).toBe(true);
  });

  it("dashboard card deep-link tolerates drift between encode and match sources", () => {
    // Card encodes from one snapshot; matcher runs against a slightly-drifted
    // refreshed snapshot (extra whitespace, punctuation, casing).
    const encodedFrom = mkRow({ __project: "Himachal", "Sr. No.": "12", "Activity List": "Site Survey" });
    const refreshed = mkRow({ __project: " himachal ", "Sr. No.": "012", "Activity List": "site-survey" });
    const key = encodeRowKey(rowIdent(encodedFrom));
    expect(rowMatchesIdent(refreshed, decodeRowKey(key))).toBe(true);
  });
});
