import { describe, expect, it } from "vitest";

import {
  STRATEGIES,
  STRATEGY_BUILD,
  STRATEGY_CATEGORIES,
  STRATEGY_CATEGORIES as CATS,
  WORKBOOK_STRATEGIES,
  TOP_N,
  basisLabel,
  categoryCount,
  evidenceScore,
  findStrategy,
  matchesQuery,
  medianRisk,
  outlookWeight,
  rankWithinCategory,
  rankedCount,
  sortForDisplay,
  strategiesInCategory,
  topByCategory,
} from "@/lib/strategies-catalog";
import type { CategoryId } from "@/lib/strategies-db";

const CATEGORY_IDS = CATS.map((c) => c.id) as CategoryId[];

describe("strategy catalogue data", () => {  it("holds every strategy the workbook survived deduplication", () => {
    expect(STRATEGIES.length).toBeGreaterThan(150);
    // the workbook arithmetic is about the sheet only:236 rows −6 emoji
    // headings −1 self-declared duplicate, minus merges. The catalog adds
    // researched rows on top, which are counted in their own test file.
    expect(STRATEGY_BUILD.sheetRows).toBe(236);
    expect(STRATEGY_BUILD.sectionHeadingsDropped).toBe(6);
    expect(STRATEGY_BUILD.duplicatesDropped).toHaveLength(1);
    expect(WORKBOOK_STRATEGIES.length + STRATEGY_BUILD.mergedSpellings.length).toBeLessThan(236);
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(WORKBOOK_STRATEGIES.length);
  });

  it("gives every strategy a unique id and a known category", () => {
    const ids = new Set(STRATEGIES.map((s) => s.id));
    expect(ids.size).toBe(STRATEGIES.length);
    for (const s of STRATEGIES) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(CATEGORY_IDS).toContain(s.category);
      expect(s.name.trim().length).toBeGreaterThan(1);
    }
  });

  it("leaves no mangled text from the workbook's double encoding", () => {
    const bad = /[ÃÂâð][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;
    for (const s of STRATEGIES) {
      expect(bad.test(s.name), s.name).toBe(false);
      for (const f of s.facts) expect(bad.test(f.value), `${s.name}: ${f.label}`).toBe(false);
    }
  });

  it("never lists the same strategy twice", () => {
    const seen = new Set<string>();
    for (const s of STRATEGIES) {
      const key = `${s.category}:${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
      expect(seen.has(key), s.name).toBe(false);
      seen.add(key);
    }
  });

  it("fills every category with at least one strategy", () => {
    for (const c of CATEGORY_IDS) expect(categoryCount(c), c).toBeGreaterThan(0);
    expect(STRATEGY_CATEGORIES.length).toBe(12);
    expect(categoryCount("equities") + categoryCount("crypto") + categoryCount("sports")).toBeGreaterThan(80);
  });
});

describe("strategy figures", () => {
  it("keeps each risk figure inside 0–1 and bands it consistently", () => {
    for (const s of STRATEGIES) {
      if (s.risk == null) {
        expect(s.band).toBe("Unknown");
        continue;
      }
      expect(s.risk).toBeGreaterThanOrEqual(0);
      expect(s.risk).toBeLessThanOrEqual(1);
      const expected =
        s.risk < 0.35 ? "Very low" : s.risk < 0.5 ? "Low" : s.risk < 0.65 ? "Moderate" : s.risk < 0.8 ? "Elevated" : s.risk < 0.95 ? "High" : "Extreme";
      expect(s.band).toBe(expected);
    }
  });

  it("only annualises a figure when the sheet's basis allows it", () => {
    for (const s of STRATEGIES) {
      if (s.retBasis === "monthly") {
        expect(s.retAnnual).toBeCloseTo((s.retMid ?? 0) * 12, 1);
      } else if (s.retBasis === "annual") {
        expect(s.retAnnual).toBe(s.retMid);
      } else {
        expect(s.retAnnual).toBeNull();
      }
      if (s.retAnnual != null) expect(s.retAnnual).toBeGreaterThan(0);
      expect(basisLabel(s).length).toBeGreaterThan(0);
    }
  });

  it("keeps the workbook's rank only where it gave one", () => {
    const ranked = STRATEGIES.filter((s) => s.coreRank != null);
    expect(ranked).toHaveLength(rankedCount());
    expect(ranked.length).toBe(17);
    for (const s of ranked) expect(s.coreRank as number).toBeGreaterThanOrEqual(1);
    // 14 are labelled "Core Rank #n"; the other three ranked rows carry a caveat
    // instead ("Category Overlap", "Platform Link / Specific", "Unviable / Speculative").
    expect(ranked.filter((s) => /core rank/i.test(s.tier))).toHaveLength(14);
  });

  it("computes RAR from the two sheet figures and nothing else", () => {
    let checked = 0;
    for (const s of STRATEGIES) {
      if (s.score == null) {
        expect(s.retAnnual == null || s.risk == null || s.risk === 0).toBe(true);
        continue;
      }
      expect(s.score).toBeCloseTo(Math.round(((s.retAnnual as number) / (s.risk as number)) * 10) / 10, 5);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("has a comparable figure for most rows", () => {
    expect(medianRisk()).not.toBeNull();
    expect(medianRisk() as number).toBeGreaterThan(0);
    expect(STRATEGIES.filter((s) => s.score != null).length).toBeGreaterThan(150);
  });
});

describe("ranking", () => {
  it("puts workbook-ranked strategies first, in the workbook's order", () => {
    const income = rankWithinCategory(strategiesInCategory("income"));
    const ranks = income.map((s) => s.coreRank).filter((r): r is number => r != null);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(income[0].coreRank).toBe(1);
  });

  it("falls back to RAR, then evidence, then name", () => {
    const ranked = rankWithinCategory(STRATEGIES);
    for (let i = 1; i < ranked.length; i++) {
      const a = ranked[i - 1];
      const b = ranked[i];
      const aRank = a.coreRank ?? Number.POSITIVE_INFINITY;
      const bRank = b.coreRank ?? Number.POSITIVE_INFINITY;
      if (aRank !== bRank) expect(aRank).toBeLessThan(bRank);
      else if ((a.score ?? -1) !== (b.score ?? -1)) expect(a.score ?? -1).toBeGreaterThan(b.score ?? -1);
      else if (evidenceScore(a) !== evidenceScore(b)) expect(evidenceScore(a)).toBeGreaterThanOrEqual(evidenceScore(b));
      else expect(a.name.localeCompare(b.name)).toBeLessThanOrEqual(0);
    }
  });

  it("returns at most five per category, each from that category", () => {
    const boards = topByCategory();
    expect(boards).toHaveLength(STRATEGY_CATEGORIES.length);
    for (const board of boards) {
      expect(board.rows.length).toBeGreaterThan(0);
      expect(board.rows.length).toBeLessThanOrEqual(TOP_N);
      for (const s of board.rows) expect(s.category).toBe(board.category.id);
      // and they are the head of the full ranking
      const full = rankWithinCategory(STRATEGIES.filter((s) => s.category === board.category.id));
      expect(board.rows.map((s) => s.id)).toEqual(full.slice(0, TOP_N).map((s) => s.id));
    }
  });

  it("ranks the medium categories without inventing values", () => {
    for (const id of CATEGORY_IDS) {
      const rows = topByCategory()[CATEGORY_IDS.indexOf(id)].rows;
      for (const s of rows) {
        if (s.coreRank == null && s.score == null) expect(s.retBasis).not.toBe("annual");
      }
    }
  });
});

describe("search and sorting", () => {
  it("matches names case-insensitively and across fields", () => {
    const merger = STRATEGIES.find((s) => /merger/i.test(s.name));
    expect(merger).toBeDefined();
    expect(matchesQuery(merger!, "MERGER")).toBe(true);
    expect(matchesQuery(merger!, "zzzz-not-a-thing")).toBe(false);
    expect(matchesQuery(merger!, "")).toBe(true);
  });

  it("finds a strategy by the id used in URLs", () => {
    const first = STRATEGIES[0];
    expect(findStrategy(first.id)?.name).toBe(first.name);
    expect(findStrategy("does-not-exist")).toBeNull();
    expect(findStrategy(null)).toBeNull();
  });

  it("sorts by return, risk and name without dropping rows", () => {
    for (const key of ["return", "risk", "name", "evidence", "rank"] as const) {
      const sorted = sortForDisplay(STRATEGIES, key);
      expect(sorted).toHaveLength(STRATEGIES.length);
    }
    const byReturn = sortForDisplay(STRATEGIES, "return");
    expect(byReturn[0].retAnnual as number).toBeGreaterThanOrEqual(byReturn[byReturn.length - 1].retAnnual ?? 0);
    const byName = sortForDisplay(STRATEGIES, "name");
    expect(byName[0].name.localeCompare(byName[1].name)).toBeLessThanOrEqual(0);
  });

  it("weights the workbook's outlook words, defaulting to neutral", () => {
    expect(outlookWeight("Very Bullish for $100k")).toBeGreaterThan(outlookWeight("Bullish"));
    expect(outlookWeight("Neutral")).toBe(1);
    expect(outlookWeight("")).toBe(1);
    expect(outlookWeight("Bearish for retail scale")).toBe(0);
  });
});
