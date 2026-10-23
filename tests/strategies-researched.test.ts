import { describe, expect, it } from "vitest";

import {
  STRATEGIES,
  WORKBOOK_STRATEGIES,
  horizonCounts,
  horizonFromMonths,
  horizonOf,
  isResearched,
  sortForDisplay,
} from "@/lib/strategies-catalog";
import { HORIZON_META, RESEARCHED_STRATEGIES } from "@/lib/strategies-researched";

const VIABILITIES = ["Viable", "Viable with conditions", "Speculative", "Mostly institutional"];
const BANNED = /\b(guaranteed|risk-free return|will return|expected to earn|recommend(ed|ation)?)\b/i;

function fieldText(s: (typeof RESEARCHED_STRATEGIES)[number]): string {
  return [s.name, s.description, s.rationale, s.keyRisk, s.viabilityNote, s.horizonText, ...s.facts.map((f) => f.value)]
    .join(" ")
    .toLowerCase();
}

describe("researched strategy additions", () => {
  it("adds at least50 strategies beyond the workbook, merged into the catalogue", () => {
    expect(RESEARCHED_STRATEGIES.length).toBeGreaterThanOrEqual(50);
    expect(STRATEGIES.length).toBe(WORKBOOK_STRATEGIES.length + RESEARCHED_STRATEGIES.length);
    // every researched row is in the merged list exactly once
    for (const s of RESEARCHED_STRATEGIES) {
      expect(STRATEGIES.filter((x) => x.id === s.id), s.name).toHaveLength(1);
    }
  });

  it("carries risk, band, viability and horizon on every row", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      expect(s.risk, s.name).not.toBeNull();
      const risk = s.risk as number;
      expect(risk, s.name).toBeGreaterThanOrEqual(0);
      expect(risk, s.name).toBeLessThanOrEqual(1);
      const expected =
        risk < 0.35 ? "Very low" : risk < 0.5 ? "Low" : risk < 0.65 ? "Moderate" : risk < 0.8 ? "Elevated" : risk < 0.95 ? "High" : "Extreme";
      expect(s.band, s.name).toBe(expected);
      expect(s.riskText, s.name).toBe(expected);
      expect(VIABILITIES, s.name).toContain(s.viability);
      expect(s.viabilityNote.trim().length, s.name).toBeGreaterThan(20);
      expect(HORIZON_META[s.horizon], s.name).toBeTruthy();
      expect(s.horizonText.trim().length, s.name).toBeGreaterThan(10);
      expect(horizonOf(s), s.name).toBe(s.horizon);
    }
  });

  it("cites only pages that were actually opened, with a note", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      expect(s.sources.length, s.name).toBeGreaterThanOrEqual(1);
      for (const src of s.sources) {
        expect(src.url.startsWith("https://"), `${s.name}: ${src.url}`).toBe(true);
        expect(src.title.trim().length, `${s.name}: title`).toBeGreaterThan(10);
        expect(src.note.trim().length, `${s.name}: note`).toBeGreaterThan(15);
      }
      // the drawer's Source meta joins the titles, so it must be non-empty
      expect(s.source.length, s.name).toBeGreaterThan(0);
    }
  });

  it("labels every figure-bearing fact as typical, historical or as-of", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      for (const f of s.facts) {
        if (/%|\$/.test(f.value)) {
          expect(
            /^(Typical|Historical|As of)/.test(f.value.trim()),
            `${s.name}: ${f.label} — ${f.value}`,
          ).toBe(true);
        }
      }
    }
  });

  it("annualises only what can honestly be annualised", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      if (s.retBasis === "annual") {
        expect(s.retAnnual, s.name).not.toBeNull();
        expect(s.retAnnual, s.name).toBe(s.retMid);
        expect(s.retAnnual as number).toBeGreaterThan(0);
        expect(s.retText, s.name).toMatch(/%/);
        expect(s.score, s.name).toBeCloseTo(Math.round(((s.retAnnual as number) / (s.risk as number)) * 10) / 10, 5);
      } else {
        expect(s.retAnnual, s.name).toBeNull();
        expect(["monthly", "per deal", "asymmetric", "not stated"], s.name).toContain(s.retBasis);
      }
    }
  });

  it("has no recommendation, guarantee or forecast language", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      expect(BANNED.test(fieldText(s)), s.name).toBe(false);
    }
  });

  it("never duplicates a workbook strategy name in the same category", () => {
    const keys = new Set(
      WORKBOOK_STRATEGIES.map((s) => `${s.category}:${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`),
    );
    for (const s of RESEARCHED_STRATEGIES) {
      const key = `${s.category}:${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
      expect(keys.has(key), s.name).toBe(false);
      keys.add(key);
    }
    expect(keys.size).toBe(STRATEGIES.length);
  });

  it("covers the short-term and long-term ends of the book", () => {
    const counts = horizonCounts(RESEARCHED_STRATEGIES);
    expect(counts.short).toBeGreaterThanOrEqual(8);
    expect(counts.medium).toBeGreaterThanOrEqual(8);
    expect(counts.long).toBeGreaterThanOrEqual(20);
  });

  it("sorts the catalogue short-term first and filters without dropping rows", () => {
    const sorted = sortForDisplay(STRATEGIES, "horizon");
    expect(sorted).toHaveLength(STRATEGIES.length);
    const orders = sorted
      .map((s) => horizonOf(s))
      .filter((h): h is NonNullable<typeof h> => h != null)
      .map((h) => HORIZON_META[h].order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    // rows with no horizon data sink to the bottom instead of disappearing
    const unknownAt = sorted.findIndex((s) => horizonOf(s) == null);
    if (unknownAt >= 0) expect(unknownAt).toBeGreaterThan(orders.length - 1);
    // and filtering by horizon keeps exactly the rows of that class
    const totals = horizonCounts();
    for (const h of ["short", "medium", "long"] as const) {
      expect(sorted.filter((s) => horizonOf(s) === h)).toHaveLength(totals[h]);
    }
  });

  it("derives a horizon for workbook rows only where the sheet states one", () => {
    expect(horizonFromMonths(6)).toBe("short");
    expect(horizonFromMonths(12)).toBe("short");
    expect(horizonFromMonths(24)).toBe("medium");
    expect(horizonFromMonths(60)).toBe("medium");
    expect(horizonFromMonths(84)).toBe("long");
    expect(horizonFromMonths(null)).toBeNull();
    const withHorizon = WORKBOOK_STRATEGIES.filter((s) => horizonOf(s) != null);
    expect(withHorizon.length).toBeGreaterThan(5);
    for (const s of WORKBOOK_STRATEGIES) expect(isResearched(s), s.name).toBe(false);
  });

  it("keeps the researched rows marked for the drawer", () => {
    for (const s of RESEARCHED_STRATEGIES) {
      expect(isResearched(s), s.name).toBe(true);
      expect(s.researched, s.name).toBe(true);
      expect(s.sheetCategory, s.name).toMatch(/researched/i);
      expect(s.coreRank, s.name).toBeNull();
      expect(s.facts.length, s.name).toBeGreaterThanOrEqual(2);
    }
  });
});
