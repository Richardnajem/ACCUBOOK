import { describe, it, expect } from "vitest";
import {
  compareToBenchmark,
  modifiedDietz,
  monthlyReturns,
  timeWeightedReturn,
  xirr,
  yearlyReturns,
} from "../src/lib/analytics/returns";
import {
  concentrationReport,
  correlationMatrix,
  drawdownInfo,
  drawdownSeries,
  monteCarloProjection,
  computeRiskMetrics,
} from "../src/lib/analytics/risk";
import { buildPortfolioHistory } from "../src/lib/analytics/history";
import { buildPortfolio, enrichWithQuotes } from "../src/lib/portfolio";
import { buildAnalyticsReport } from "../src/lib/analytics/report";
import { normaliseConfig } from "../src/lib/analytics/config";
import type { Trade } from "../src/lib/db";

let nextId = 1;
function trade(partial: Partial<Trade> & { type: Trade["type"] }): Trade {
  return {
    id: nextId++,
    date: "2024-01-02",
    symbol: null,
    shares: null,
    price: null,
    fees: 0,
    notes: null,
    created_at: "2024-01-02T00:00:00.000Z",
    ...partial,
  };
}


// ─── XIRR ───────────────────────────────────────────────────────────────────
describe("xirr", () => {
  it("solves the one-year 10% case", () => {
    const r = xirr([
      { date: "2023-01-01", amount: -1000 },
      { date: "2024-01-01", amount: 1100 },
    ]);
    expect(r).not.toBeNull();
    expect(r! * 100).toBeCloseTo(10, 4);
  });

  it("handles multiple contributions", () => {
    const r = xirr([
      { date: "2023-01-01", amount: -1000 },
      { date: "2023-07-01", amount: -1000 },
      { date: "2024-01-01", amount: 2100 },
    ]);
    expect(r).not.toBeNull();
    expect(r! * 100).toBeGreaterThan(4);
    expect(r! * 100).toBeLessThan(10);
  });

  it("returns null without both a contribution and a distribution", () => {
    expect(xirr([{ date: "2023-01-01", amount: -100 }])).toBeNull();
    expect(xirr([{ date: "2023-01-01", amount: 100 }, { date: "2024-01-01", amount: 200 }])).toBeNull();
  });

  it("returns a negative rate for a loss", () => {
    const r = xirr([
      { date: "2023-01-01", amount: -1000 },
      { date: "2024-01-01", amount: 900 },
    ]);
    expect(r!).toBeCloseTo(-0.1, 3);
  });
});

// ─── TWR / Dietz / calendars ────────────────────────────────────────────────
describe("time-weighted return", () => {
  it("links daily returns geometrically", () => {
    const daily = [
      { date: "2024-01-02", ret: 0.1 },
      { date: "2024-01-03", ret: -0.1 },
    ];
    const r = timeWeightedReturn(daily);
    expect(r.cumulative).toBeCloseTo(-0.01, 12);
    // Under a year: no annualisation.
    expect(r.annualised).toBeNull();
  });

  it("annualises a multi-year cumulative return", () => {
    const daily = [
      { date: "2022-01-03", ret: 0.1 },
      { date: "2024-12-31", ret: 0.1 },
    ];
    const r = timeWeightedReturn(daily);
    expect(r.annualised).not.toBeNull();
    expect(r.annualised!).toBeGreaterThan(0);
  });
});

describe("modifiedDietz", () => {
  it("weights a mid-period flow at half", () => {
    const r = modifiedDietz(1000, 1200, [{ date: "2023-07-02", amount: 100 }], "2023-01-01", "2024-01-01");
    expect(r).not.toBeNull();
    expect(r! * 100).toBeCloseTo(9.52, 1);
  });

  it("rejects a zero opening value", () => {
    expect(modifiedDietz(0, 100, [], "2024-01-01", "2024-06-01")).toBeNull();
  });
});

describe("calendar aggregation", () => {
  it("compounds month and year buckets", () => {
    const daily = [
      { date: "2024-01-05", ret: 0.1 },
      { date: "2024-01-20", ret: 0.1 },
      { date: "2024-02-05", ret: -0.1 },
    ];
    const months = monthlyReturns(daily);
    expect(months).toHaveLength(2);
    expect(months[0].ret).toBeCloseTo(0.21, 12);
    expect(months[1].ret).toBeCloseTo(-0.1, 12);
    const years = yearlyReturns(daily);
    expect(years).toHaveLength(1);
    expect(years[0].ret).toBeCloseTo(1.21 * 0.9 - 1, 12);
    expect(years[0].months).toBe(2);
  });
});

describe("benchmark comparison", () => {
  it("computes excess return, tracking error and capture", () => {
    const portfolio = [
      { date: "2024-01-02", ret: 0.02 },
      { date: "2024-01-03", ret: -0.01 },
      { date: "2024-01-04", ret: 0.03 },
    ];
    const benchmark = [
      { date: "2024-01-02", ret: 0.01 },
      { date: "2024-01-03", ret: -0.02 },
      { date: "2024-01-04", ret: 0.01 },
    ];
    const c = compareToBenchmark(portfolio, benchmark, "SPY");
    expect(c.observations).toBe(3);
    expect(c.excessReturnPct!).toBeGreaterThan(0);
    expect(c.trackingErrorPct!).toBeGreaterThan(0);
    expect(c.upCapturePct!).toBeGreaterThan(100);
    expect(c.downCapturePct!).toBeLessThan(100);
  });

  it("reports only the overlap", () => {
    const c = compareToBenchmark(
      [{ date: "2024-01-02", ret: 0.01 }, { date: "2024-01-09", ret: 0.01 }],
      [{ date: "2024-01-02", ret: 0.01 }],
      "SPY",
    );
    expect(c.observations).toBe(1);
    expect(c.informationRatio).toBeNull();
  });
});

// ─── Risk ───────────────────────────────────────────────────────────────────
describe("drawdowns", () => {
  const points = [
    { date: "2024-01-01", value: 100 },
    { date: "2024-01-02", value: 110 },
    { date: "2024-01-03", value: 99 },
    { date: "2024-01-04", value: 108.9 },
  ];

  it("finds the peak, trough and current drawdown", () => {
    const d = drawdownInfo(points);
    expect(d.maxDrawdownPct).toBeCloseTo(-10, 10);
    expect(d.peakDate).toBe("2024-01-02");
    expect(d.troughDate).toBe("2024-01-03");
    expect(d.recoveryDate).toBeNull();
    expect(d.currentDrawdownPct).toBeCloseTo(-1, 10);
  });

  it("records the recovery date once the old high is regained", () => {
    const d = drawdownInfo([...points, { date: "2024-01-05", value: 111 }]);
    expect(d.recoveryDate).toBe("2024-01-05");
    expect(d.currentDrawdownPct).toBeCloseTo(0, 10);
  });

  it("builds a running drawdown series", () => {
    const series = drawdownSeries(points);
    expect(series).toHaveLength(4);
    expect(series[2].drawdownPct).toBeCloseTo(-10, 10);
  });
});

describe("computeRiskMetrics", () => {
  const values = Array.from({ length: 260 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 2) + i * 86_400_000).toISOString().slice(0, 10),
    value: 100 * Math.pow(1.0004, i),
  }));

  it("computes volatility, Sharpe and Sortino from a steady series", () => {
    const daily = values.slice(1).map((v, i) => ({
      date: v.date,
      ret: v.value / values[i].value - 1,
    }));
    const m = computeRiskMetrics(daily, values, { riskFreePct: 0, marPct: 0 });
    expect(m.observations).toBe(259);
    expect(m.annualisedVolPct).toBeCloseTo(0, 6);
    // Zero volatility makes Sharpe undefined rather than infinite.
    expect(m.sharpe).toBeNull();
    expect(m.maxDrawdownPct).toBeCloseTo(0, 10);
    expect(m.totalReturnPct!).toBeGreaterThan(9);
  });

  it("computes beta = 1 and alpha ≈ 0 against itself", () => {
    const daily = values.slice(1).map((v, i) => ({
      date: v.date,
      ret: (v.value / values[i].value - 1) * (1 + (i % 2 === 0 ? 0.001 : -0.001)),
    }));
    const m = computeRiskMetrics(daily, values, {
      riskFreePct: 2,
      benchmark: { symbol: "SPY", returns: daily },
    });
    expect(m.beta).toBeCloseTo(1, 6);
    expect(m.alphaAnnualPct!).toBeCloseTo(0, 6);
    expect(m.rSquared).toBeCloseTo(1, 6);
    expect(m.trackingErrorPct).toBeCloseTo(0, 6);
  });

  it("reports one-day VaR and CVaR with the tail no milder than VaR", () => {
    const daily = [
      { date: "2024-01-02", ret: -0.03 },
      { date: "2024-01-03", ret: -0.01 },
      { date: "2024-01-04", ret: 0.005 },
      { date: "2024-01-05", ret: 0.01 },
      { date: "2024-01-08", ret: 0.02 },
      { date: "2024-01-09", ret: 0.004 },
      { date: "2024-01-10", ret: -0.005 },
      { date: "2024-01-11", ret: 0.007 },
      { date: "2024-01-12", ret: 0.001 },
      { date: "2024-01-15", ret: 0.003 },
    ];
    const m = computeRiskMetrics(daily, values);
    expect(m.var95Pct!).toBeGreaterThan(0);
    expect(m.cvar95Pct!).toBeGreaterThanOrEqual(m.var95Pct!);
  });

  it("leaves benchmark measures null when there is no benchmark", () => {
    const m = computeRiskMetrics([{ date: "2024-01-02", ret: 0.01 }], values);
    expect(m.beta).toBeNull();
    expect(m.alphaAnnualPct).toBeNull();
  });
});

describe("correlation and concentration", () => {
  it("correlates identical series at 1", () => {
    const series: Record<string, Array<{ date: string; value: number }>> = {};
    for (let i = 0; i < 40; i++) {
      const date = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const value = 100 + i;
      (series.A ??= []).push({ date, value });
      (series.B ??= []).push({ date, value: value * 2 });
    }
    const c = correlationMatrix(series);
    expect(c.symbols).toEqual(["A", "B"]);
    expect(c.matrix[0][1]).toBeCloseTo(1, 8);
    expect(c.topPairs[0].correlation).toBeCloseTo(1, 8);
  });

  it("computes HHI, effective names and guardrail breaches", () => {
    const c = concentrationReport(
      [
        { symbol: "AAPL", weightPct: 50 },
        { symbol: "MSFT", weightPct: 30 },
        { symbol: "KO", weightPct: 20 },
      ],
      25,
    );
    expect(c.hhi).toBeCloseTo(0.38, 10);
    expect(c.effectivePositions!).toBeCloseTo(1 / 0.38, 8);
    expect(c.top1Pct).toBe(50);
    expect(c.breaches.map((b) => b.symbol)).toEqual(["AAPL", "MSFT"]);
  });
});

describe("monteCarloProjection", () => {
  it("is deterministic for a seed and brackets the median", () => {
    const a = monteCarloProjection({
      startValue: 10_000,
      monthlyContribution: 100,
      years: 5,
      meanAnnualPct: 7,
      volAnnualPct: 15,
      simulations: 400,
      seed: 42,
    });
    const b = monteCarloProjection({
      startValue: 10_000,
      monthlyContribution: 100,
      years: 5,
      meanAnnualPct: 7,
      volAnnualPct: 15,
      simulations: 400,
      seed: 42,
    });
    expect(a.finalP50).toBe(b.finalP50);
    expect(a.finalP10).toBeLessThan(a.finalP50);
    expect(a.finalP50).toBeLessThan(a.finalP90);
    expect(a.points).toHaveLength(6);
    expect(a.contributed).toBeCloseTo(16_000, 0);
    expect(a.probabilityBelowContributionsPct).toBeGreaterThanOrEqual(0);
    expect(a.probabilityBelowContributionsPct).toBeLessThanOrEqual(100);
  });

  it("grows with no volatility by exactly the assumed return", () => {
    const r = monteCarloProjection({
      startValue: 1000,
      monthlyContribution: 0,
      years: 10,
      meanAnnualPct: 7,
      volAnnualPct: 0,
      simulations: 100,
      seed: 1,
    });
    expect(r.finalP50).toBeCloseTo(1000 * Math.pow(1.07, 10), 2);
  });
});

// ─── History ────────────────────────────────────────────────────────────────
describe("buildPortfolioHistory", () => {
  const bars = {
    AAPL: [
      { date: "2024-01-02", close: 100 },
      { date: "2024-01-03", close: 110 },
      { date: "2024-01-04", close: 121 },
    ],
  };

  it("produces a flow-free total-return index", () => {
    nextId = 1;
    const h = buildPortfolioHistory(
      [
        trade({ type: "deposit", price: 1000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, date: "2024-01-02" }),
      ],
      bars,
    );
    expect(h.daily).toHaveLength(2);
    expect(h.daily[0].ret).toBeCloseTo(0.1, 10);
    expect(h.daily[1].ret).toBeCloseTo(0.1, 10);
    const last = h.levels[h.levels.length - 1];
    expect(last.value).toBeCloseTo(121, 6);
  });

  it("is unaffected by the timing of an external deposit", () => {
    nextId = 1;
    const h = buildPortfolioHistory(
      [
        trade({ type: "deposit", price: 1000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, date: "2024-01-02" }),
        trade({ type: "deposit", price: 5000, date: "2024-01-04" }),
      ],
      bars,
    );
    expect(h.daily[1].ret).toBeCloseTo(0.1, 10);
  });

  it("names symbols with no cached history instead of guessing", () => {
    nextId = 1;
    const h = buildPortfolioHistory(
      [
        trade({ type: "deposit", price: 1000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "MISSING", shares: 1, price: 100, date: "2024-01-02" }),
      ],
      bars,
    );
    expect(h.missingSymbols).toContain("MISSING");
    expect(h.symbolsUsed).toHaveLength(0);
    expect(h.warnings.join(" ")).toContain("MISSING");
  });

  it("charges fees against the daily return", () => {
    nextId = 1;
    const h = buildPortfolioHistory(
      [
        trade({ type: "deposit", price: 1000, date: "2024-01-01" }),
        trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, fees: 10, date: "2024-01-02" }),
      ],
      {
        AAPL: [
          { date: "2024-01-02", close: 100 },
          { date: "2024-01-03", close: 100 },
        ],
      },
    );
    // 10% price move would be 0; the fee is an extra drag on the first day's return.
    expect(h.levels[h.levels.length - 1].value).toBeLessThan(100);
  });
});

// ─── End-to-end report ──────────────────────────────────────────────────────
describe("buildAnalyticsReport", () => {
  it("assembles every section from a small ledger", () => {
    nextId = 1;
    const trades: Trade[] = [
      trade({ type: "deposit", price: 10_000, date: "2024-01-01" }),
      trade({ type: "buy", symbol: "AAPL", shares: 50, price: 100, fees: 5, date: "2024-01-02" }),
      trade({ type: "buy", symbol: "MSFT", shares: 10, price: 200, date: "2024-01-02" }),
      trade({ type: "dividend", symbol: "AAPL", price: 40, date: "2024-03-15" }),
      trade({ type: "deposit", price: 2_000, date: "2024-04-01" }),
    ];
    const snapshot = buildPortfolio(trades);
    const { snapshot: enriched, quoted } = enrichWithQuotes(snapshot, {
      AAPL: { price: 120, change: 1, changePercent: 0.8, name: "Apple", currency: "USD" },
      MSFT: { price: 220, change: -1, changePercent: -0.5, name: "Microsoft", currency: "USD" },
    });
    const report = buildAnalyticsReport({
      trades,
      snapshot: enriched,
      quoted,
      bars: {
        AAPL: [
          { date: "2024-01-02", close: 100 },
          { date: "2024-02-01", close: 110 },
          { date: "2024-03-01", close: 115 },
          { date: "2024-04-01", close: 120 },
          { date: "2024-05-01", close: 118 },
          { date: "2024-06-03", close: 125 },
        ],
        MSFT: [
          { date: "2024-01-02", close: 200 },
          { date: "2024-02-01", close: 210 },
          { date: "2024-03-01", close: 205 },
          { date: "2024-04-01", close: 215 },
          { date: "2024-05-01", close: 225 },
          { date: "2024-06-03", close: 220 },
        ],
      },
      benchmarkBars: [
        { date: "2024-01-02", close: 400 },
        { date: "2024-02-01", close: 410 },
        { date: "2024-03-01", close: 415 },
        { date: "2024-04-01", close: 420 },
        { date: "2024-05-01", close: 418 },
        { date: "2024-06-03", close: 430 },
      ],
      benchmarkSymbol: "SPY",
      config: normaliseConfig({ riskFreePct: 4, years: 5 }),
      now: "2024-06-03",
    });

    expect(report.performance.levels.length).toBeGreaterThan(2);
    expect(report.performance.twrCumulativePct).not.toBeNull();
    expect(report.performance.monthly.length).toBeGreaterThan(0);
    expect(report.performance.benchmark?.benchmark).toBe("SPY");
    expect(report.performance.contribution.rows).toHaveLength(2);
    // Waterfall reconciles with total P&L exactly.
    expect(Math.abs(report.performance.waterfall.residual)).toBeLessThan(1e-6);
    expect(report.risk.metrics.observations).toBeGreaterThan(2);
    expect(report.risk.concentration.positions).toBe(2);
    expect(report.risk.stress.length).toBe(5);
    expect(report.tax.report.realized).toHaveLength(0);
    expect(report.tax.report.openLots.length).toBe(2);
    expect(report.income.trailing12m).toBe(40);
    expect(report.planning.monteCarlo.points.length).toBe(report.config.goal.years + 1);
    expect(report.dataQuality.hasBenchmark).toBe(true);
  });
});
