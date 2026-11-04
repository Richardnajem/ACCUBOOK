// Rules for the fundamentals forward-return study, pinned on synthetic data.
//
// The live measurement is `tests/fundamentals-forward-live.test.ts` (opt-in,
// network). It cannot assert a result — the whole point is that nobody knows
// whether the fundamentals composite predicts anything. What it must not do is
// quietly cheat, so these tests hold the three ways it could:
//
//   • look-ahead: an observation must never enter before its filing is public,
//   • an open window counting as a return,
//   • a rising sample being read as predictive, which is why the luck band and
//     the cross-sectional IC are both part of the verdict.

import { describe, it, expect } from "vitest";
import {
  addDays,
  auc,
  buildPointInTimeScores,
  compareScores,
  firstBarAtOrAfter,
  forwardReturn,
  luckBand,
  publicDate,
  spearman,
  type PriceBar,
  type StudyRow,
} from "../src/lib/fundamentals-forward";
import type { AnnualRow } from "../src/lib/research";

const row = (fy: number, end: string, over: Partial<AnnualRow> = {}): AnnualRow => ({
  fy,
  end,
  revenue: 1_000 + fy * 100,
  grossProfit: 400 + fy * 40,
  operatingIncome: 150 + fy * 15,
  netIncome: 100 + fy * 10,
  epsDiluted: 2,
  assets: 2_000 + fy * 100,
  liabilities: 900,
  equity: 1_100,
  currentAssets: 800,
  currentLiabilities: 300,
  cash: 250,
  debt: 300,
  sharesOutstanding: 100,
  operatingCashFlow: 130 + fy * 10,
  capex: 40,
  dividendsPaid: 10,
  depreciation: 30,
  freeCashFlow: 90 + fy * 10,
  retainedEarnings: 500,
  pretaxIncome: 130 + fy * 12,
  receivables: 200,
  sga: 120,
  propertyPlantEquipment: 700,
  interestExpense: 20,
  ...over,
});

/** Daily bars, one per calendar day, close = 100 + 0.1 · day index. */
function bars(from: string, days: number): PriceBar[] {
  return Array.from({ length: days }, (_, i) => ({
    date: addDays(from, i),
    close: 100 + i * 0.1,
  }));
}

describe("publicDate / addDays", () => {
  it("falls back to the statutory deadline and prefers an exact filing date", () => {
    // 2020-12-31 + 90 days = 2021-03-31 (Jan 31 + Feb 28 + Mar 31).
    expect(publicDate("2020-12-31")).toBe("2021-03-31");
    expect(publicDate("2020-12-31", "2021-02-05")).toBe("2021-02-05");
    expect(publicDate("2020-12-31", "")).toBe("2021-03-31");
    expect(publicDate("not-a-date")).toBeNull();
  });

  it("crosses a leap day without drifting", () => {
    expect(addDays("2020-02-28", 1)).toBe("2020-02-29");
    expect(addDays("2020-02-28", 2)).toBe("2020-03-01");
  });
});

describe("forwardReturn", () => {
  it("measures to the first session at or after one year", () => {
    const series = bars("2020-01-01", 800);
    const entryIndex = 10;
    const exitIndex = firstBarAtOrAfter(series, addDays(series[entryIndex].date, 365));
    const result = forwardReturn(series, entryIndex)!;
    expect(result.exitDate).toBe(series[exitIndex].date);
    expect(result.bars).toBe(exitIndex - entryIndex);
    expect(result.pct).toBeCloseTo((series[exitIndex].close / series[entryIndex].close - 1) * 100, 10);
  });

  it("returns null for an open window instead of an incomplete number", () => {
    const series = bars("2020-01-01", 100);
    expect(forwardReturn(series, 10)).toBeNull();
  });
});

describe("buildPointInTimeScores", () => {
  const annual = [
    row(2023, "2023-12-31"),
    row(2022, "2022-12-31"),
    row(2021, "2021-12-31"),
    row(2020, "2020-12-31"),
    row(2019, "2019-12-31"),
  ];
  const series = bars("2019-01-01", 2600); // through mid-2026

  it("scores each year from the statements public at the time", () => {
    const { observations, skipped } = buildPointInTimeScores("TEST", annual, series);
    // Five rows, and the three oldest cannot form a 3-year comparison.
    expect(observations.map((o) => o.fy)).toEqual([2023, 2022, 2021]);
    expect(skipped.map((s) => s.fy)).toEqual([2020, 2019]);
    expect(skipped[0].reason).toContain("statement year");
    for (const obs of observations) {
      expect(obs.score).toBeGreaterThan(0);
      expect(obs.score).toBeLessThanOrEqual(100);
    }
  });

  it("never enters before the filing is public", () => {
    const { observations } = buildPointInTimeScores("TEST", annual, series);
    for (const obs of observations) {
      expect(obs.knownFrom).toBe(addDays(obs.periodEnd, 90));
      expect(obs.entryDate! >= obs.knownFrom).toBe(true);
      // The stated return is the move from the entry session, not from the
      // fiscal-year end (which would be look-ahead).
      const entryIndex = series.findIndex((b) => b.date === obs.entryDate);
      const exitIndex = firstBarAtOrAfter(series, addDays(obs.entryDate!, 365));
      expect(obs.forwardReturnPct).toBeCloseTo(
        (series[exitIndex].close / series[entryIndex].close - 1) * 100,
        10
      );
    }
  });

  it("keeps a year whose market cap cannot be rebuilt", () => {
    const noShares = [row(2023, "2023-12-31", { sharesOutstanding: null }), ...annual.slice(1)];
    const { observations } = buildPointInTimeScores("TEST", noShares, series);
    // The score is still produced (Altman/magic formula go unavailable rather
    // than the whole year being dropped).
    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0].score).toBeGreaterThan(0);
  });

  it("excludes a year the cache has no price for", () => {
    const late = [row(2030, "2030-12-31"), row(2029, "2029-12-31"), row(2028, "2028-12-31")];
    const { observations, skipped } = buildPointInTimeScores("TEST", late, series);
    expect(observations).toHaveLength(0);
    expect(skipped[0].reason).toContain("no cached session");
  });
});

describe("separation statistics", () => {
  it("AUC is 1 for a perfect ordering and 0.5 with no relation", () => {
    const perfect = Array.from({ length: 20 }, (_, i) => ({ score: i, ret: i * 0.01 }));
    expect(auc(perfect)).toBe(1);
    // Same returns, scores reversed: 0.
    const reversed = perfect.map((p, i) => ({ score: i, ret: (20 - i) * 0.01 }));
    expect(auc(reversed)).toBe(0);
    // Identical scores cannot separate anything: every pair is a coin flip.
    const flat = perfect.map((p) => ({ score: 5, ret: p.ret }));
    expect(auc(flat)).toBe(0.5);
  });

  it("drops tied outcomes and refuses a single-class sample", () => {
    expect(auc([{ score: 1, ret: 5 }, { score: 9, ret: 5 }])).toBeNull();
    expect(auc([{ score: 1, ret: 5 }])).toBeNull();
  });

  it("the luck band narrows as the sample grows", () => {
    const small = luckBand(30);
    const large = luckBand(300);
    expect(small.high).toBeGreaterThan(large.high);
    expect(small.low).toBeLessThan(0.5);
    expect(large.low).toBeGreaterThan(small.low);
  });

  it("spearman ranks ties by average", () => {
    expect(spearman([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3], [30, 20, 10])).toBeCloseTo(-1, 10);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  });
});

describe("compareScores", () => {
  /** Four filing-year cohorts of ten names each. */
  const buildRows = (ret: (score: number, i: number) => number): StudyRow[] => {
    const rows: StudyRow[] = [];
    for (let year = 0; year < 4; year++) {
      for (let i = 0; i < 10; i++) {
        const score = 30 + i * 7;
        rows.push({
          symbol: `S${i}`,
          fy: 2015 + year,
          knownFrom: `${2016 + year}-03-31`,
          score,
          forwardReturnPct: ret(score, i),
        });
      }
    }
    return rows;
  };

  it("reports an edge when the score really orders the outcome", () => {
    const report = compareScores(buildRows((score) => (score - 65) * 0.4))!;
    expect(report.n).toBe(40);
    expect(report.symbols).toBe(10);
    expect(report.cohorts).toBe(4);
    expect(report.rawAuc).toBe(1);
    expect(report.meanIc).toBeCloseTo(1, 10);
    expect(report.icPositiveShare).toBe(1);
    expect(report.spreadPct).toBeGreaterThan(0);
    expect(report.buckets[report.buckets.length - 1].meanPct).toBeGreaterThan(report.buckets[0].meanPct);
    expect(report.clears.overall).toBe(true);
  });

  it("does not call a rising sample predictive when the ordering is noise", () => {
    // Every name rises with the year (so the whole sample drifts up), but the
    // score's ordering within each cohort is flat. A pooled AUC alone would be
    // tempted by the drift; the IC read is what refuses it.
    const rows = buildRows((_, i) => 10 + (i % 2) * 0.5);
    const report = compareScores(rows)!;
    expect(report.rawAuc).not.toBeNull();
    expect(report.clears.overall).toBe(false);
    expect(report.clears.reason.length).toBeGreaterThan(0);
    expect(Math.abs(report.meanIc ?? 0)).toBeLessThan(1);
  });

  it("returns null when there is nothing to measure", () => {
    expect(compareScores([])).toBeNull();
    expect(
      compareScores(
        Array.from({ length: 5 }, (_, i) => ({
          symbol: "A",
          fy: 2020,
          knownFrom: "2021-03-31",
          score: i * 10,
          forwardReturnPct: i,
        }))
      )
    ).toBeNull();
  });

  it("removes each symbol's own average before the within-symbol read", () => {
    // Two names: A scores high and rises a lot, B scores low and falls. Pooled
    // separation is perfect. The within-symbol read has no ordering left once
    // each name's own average year is subtracted, and that is the honest answer
    // to "would the score have picked the better year for the same stock".
    const rows: StudyRow[] = [];
    // Five cohorts, so the report's ten-observation floor is cleared.
    for (let year = 0; year < 5; year++) {
      rows.push({ symbol: "A", fy: 2015 + year, knownFrom: `${2016 + year}-03-31`, score: 80, forwardReturnPct: 20 });
      rows.push({ symbol: "B", fy: 2015 + year, knownFrom: `${2016 + year}-03-31`, score: 30, forwardReturnPct: -10 });
    }
    const report = compareScores(rows)!;
    expect(report.rawAuc).toBe(1);
    expect(report.withinSymbolAuc).toBeNull(); // every symbol has zero variance
  });
});
