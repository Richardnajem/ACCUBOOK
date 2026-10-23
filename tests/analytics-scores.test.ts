import { describe, it, expect } from "vitest";
import type { AnnualRow } from "../src/lib/research";
import {
  altmanZ,
  beneishMScore,
  dupont,
  evToEbitda,
  fcfYield,
  grahamCriteria,
  grahamNumber,
  magicFormula,
  ownerEarnings,
  pegRatio,
  piotroskiFScore,
  scoreCompany,
  sloanAccruals,
} from "../src/lib/analytics/scoring";
import { buildTaxReport, cleanRepurchaseDate, harvestCandidates } from "../src/lib/analytics/tax";
import {
  covarianceMatrix,
  driftReport,
  feeReport,
  goalPlan,
  incomeReport,
  inverseVolWeights,
  kellySizing,
  rebalanceTrades,
  riskParityWeights,
} from "../src/lib/analytics/allocation";
import { lifetimeContribution, periodContribution, pnlWaterfall } from "../src/lib/analytics/attribution";
import type { Trade } from "../src/lib/db";

let nextId = 1;
function trade(partial: Partial<Trade> & { type: Trade["type"] }): Trade {
  return {
    id: nextId++,
    date: "2024-01-01",
    symbol: null,
    shares: null,
    price: null,
    fees: 0,
    notes: null,
    created_at: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

function row(overrides: Partial<AnnualRow> & { fy: number; end: string }): AnnualRow {
  return {
    revenue: null,
    grossProfit: null,
    operatingIncome: null,
    netIncome: null,
    epsDiluted: null,
    assets: null,
    liabilities: null,
    equity: null,
    currentAssets: null,
    currentLiabilities: null,
    cash: null,
    debt: null,
    sharesOutstanding: null,
    operatingCashFlow: null,
    capex: null,
    dividendsPaid: null,
    depreciation: null,
    freeCashFlow: null,
    retainedEarnings: null,
    pretaxIncome: null,
    receivables: null,
    sga: null,
    propertyPlantEquipment: null,
    interestExpense: null,
    ...overrides,
  };
}

// A profitable, improving manufacturer. All nine Piotroski tests pass by
// construction: ROA up, CFO positive, leverage down, liquidity up, no issuance,
// margin up, turnover up.
const cur = row({
  fy: 2024,
  end: "2024-12-31",
  revenue: 1200,
  grossProfit: 500,
  operatingIncome: 150,
  netIncome: 100,
  epsDiluted: 1,
  assets: 1000,
  liabilities: 400,
  equity: 600,
  currentAssets: 400,
  currentLiabilities: 200,
  cash: 100,
  debt: 200,
  sharesOutstanding: 100,
  operatingCashFlow: 120,
  capex: 40,
  dividendsPaid: 20,
  depreciation: 30,
  freeCashFlow: 80,
  retainedEarnings: 300,
  pretaxIncome: 130,
  receivables: 100,
  sga: 80,
  propertyPlantEquipment: 500,
  interestExpense: 10,
});
const prev = row({
  fy: 2023,
  end: "2023-12-31",
  revenue: 1000,
  grossProfit: 400,
  operatingIncome: 110,
  netIncome: 80,
  epsDiluted: 0.8,
  assets: 900,
  liabilities: 400,
  equity: 500,
  currentAssets: 380,
  currentLiabilities: 220,
  cash: 90,
  debt: 230,
  sharesOutstanding: 100,
  operatingCashFlow: 90,
  capex: 35,
  depreciation: 30,
  freeCashFlow: 55,
  retainedEarnings: 210,
  pretaxIncome: 100,
  receivables: 90,
  sga: 75,
  propertyPlantEquipment: 450,
  interestExpense: 12,
});
const prev2 = row({
  fy: 2022,
  end: "2022-12-31",
  revenue: 800,
  grossProfit: 320,
  netIncome: 60,
  epsDiluted: 0.64,
  assets: 800,
  equity: 420,
  currentAssets: 300,
  currentLiabilities: 210,
  debt: 240,
  sharesOutstanding: 100,
  operatingCashFlow: 70,
  capex: 30,
  propertyPlantEquipment: 400,
});
const annual = [cur, prev, prev2];

describe("Piotroski F-score", () => {
  it("scores 9/9 when every signal is positive", () => {
    const f = piotroskiFScore(annual);
    expect(f.available).toBe(9);
    expect(f.value).toBe(9);
    expect(f.zone).toBe("strong");
    expect(f.checks.every((c) => c.pass === true)).toBe(true);
  });

  it("does not report an F-score when inputs are missing", () => {
    const f = piotroskiFScore([row({ fy: 2024, end: "2024-12-31", revenue: 10, netIncome: 1 })]);
    expect(f.value).toBeNull();
    expect(f.available).toBeLessThan(9);
    expect(f.missing.length).toBeGreaterThan(0);
  });
});

describe("Altman Z", () => {
  it("computes the original five-factor model and classifies the zone", () => {
    const z = altmanZ(annual, 2000, "original");
    // 1.2*0.2 + 1.4*0.3 + 3.3*0.15 + 0.6*5 + 1.0*1.2 = 5.355
    expect(z.value!).toBeCloseTo(5.355, 6);
    expect(z.zone).toBe("safe");
    expect(z.model).toBe("original");
  });

  it("uses book equity in the non-manufacturer variant and has no X5", () => {
    const z = altmanZ(annual, 2000, "non-manufacturer");
    expect(z.value).not.toBeNull();
    expect(z.components.x5).toBeNull();
    expect(z.components.x4).toBeCloseTo(1.5, 10); // 600/400
  });

  it("is unavailable without retained earnings", () => {
    const noRe = [{ ...cur, retainedEarnings: null }, prev, prev2];
    const z = altmanZ(noRe, 2000, "original");
    expect(z.value).toBeNull();
    expect(z.missing.join(" ")).toContain("retained earnings");
  });
});

describe("Beneish M-score", () => {
  it("computes all eight variables from two years of statements", () => {
    const b = beneishMScore(annual);
    expect(b.value).not.toBeNull();
    expect(Object.values(b.variables).every((v) => v !== null)).toBe(true);
    expect(b.variables.SGI!).toBeCloseTo(1.2, 10);
    expect(b.flagged).toBe(b.value! > -2.22);
  });

  it("refuses to score without SG&A", () => {
    const noSga = [{ ...cur, sga: null }, prev, prev2];
    const b = beneishMScore(noSga);
    expect(b.value).toBeNull();
    expect(b.missing).toContain("SGAI");
  });
});

describe("accruals and DuPont", () => {
  it("computes Sloan accruals on average assets", () => {
    const a = sloanAccruals(annual);
    expect(a.value!).toBeCloseTo(((100 - 120) / 950) * 100, 6);
    expect(a.zone).toBe("cash-backed earnings");
  });

  it("decomposes ROE three ways and five ways", () => {
    const d = dupont(annual);
    expect(d.three.roePct!).toBeCloseTo((100 / 550) * 100, 6);
    expect(d.three.netMarginPct!).toBeCloseTo((100 / 1200) * 100, 6);
    expect(d.three.assetTurnover!).toBeCloseTo(1200 / 950, 6);
    expect(d.three.equityMultiplier!).toBeCloseTo(950 / 550, 6);
    expect(d.five).not.toBeNull();
    expect(d.five!.taxBurdenPct!).toBeCloseTo((100 / 130) * 100, 6);
    expect(d.five!.interestBurdenPct!).toBeCloseTo((130 / 150) * 100, 6);
    expect(d.five!.ebitMarginPct!).toBeCloseTo((150 / 1200) * 100, 6);
  });
});

describe("Graham", () => {
  it("computes the Graham number and upside", () => {
    const g = grahamNumber(annual, 10);
    expect(g.bookValuePerShare).toBeCloseTo(6, 10);
    expect(g.value!).toBeCloseTo(Math.sqrt(22.5 * 6), 10);
    expect(g.upsidePct!).toBeGreaterThan(0);
  });

  it("runs the defensive checklist and marks untestable rules as null", () => {
    const g = grahamCriteria(annual, 10, 2000);
    expect(g.available).toBeGreaterThan(3);
    const dividend = g.checks.find((c) => c.label.includes("Dividend"))!;
    expect(dividend.pass).toBeNull();
    const size = g.checks.find((c) => c.label.includes("size"))!;
    // The fixture is a toy company: 1,200 of sales is far below Graham's
    // $100m floor, so the rule must fail rather than pass by accident.
    expect(size.pass).toBe(false);
    // Filings are reported in dollars, so a $150m-revenue company passes it.
    const big = grahamCriteria([{ ...cur, revenue: 150_000_000 }, prev, prev2], 10, 2000);
    expect(big.checks.find((c) => c.label.includes("size"))!.pass).toBe(true);
  });
});

describe("Magic Formula, PEG and cash-flow yields", () => {
  it("computes return on capital and earnings yield", () => {
    const m = magicFormula(annual, 2000);
    expect(m.returnOnCapitalPct!).toBeCloseTo((150 / 700) * 100, 6);
    expect(m.enterpriseValue).toBe(2100);
    expect(m.earningsYieldPct!).toBeCloseTo((150 / 2100) * 100, 6);
    expect(m.missing).toHaveLength(0);
  });

  it("uses the filed EPS CAGR for PEG", () => {
    const p = pegRatio(annual, 2000);
    expect(p.pe).toBe(20);
    expect(p.growthPct!).toBeCloseTo(25, 6);
    expect(p.peg!).toBeCloseTo(0.8, 6);
  });

  it("computes EV/EBITDA and FCF yield", () => {
    const e = evToEbitda(annual, 2000);
    expect(e.ev).toBe(2100);
    expect(e.ebitda).toBe(180);
    expect(e.multiple!).toBeCloseTo(2100 / 180, 6);
    const f = fcfYield(annual, 2000);
    expect(f.yieldPct!).toBeCloseTo(4, 6);
  });

  it("computes owner earnings as NI + D&A − capex", () => {
    expect(ownerEarnings(annual).value).toBe(90);
    expect(ownerEarnings([row({ fy: 2024, end: "2024-12-31" })]).value).toBeNull();
  });

  it("blends a composite score", () => {
    const s = scoreCompany(annual, 2000, 10);
    expect(s.composite).not.toBeNull();
    expect(s.composite!).toBeGreaterThan(0);
    expect(s.composite!).toBeLessThanOrEqual(100);
    expect(s.compositeBasis).toContain("Piotroski");
  });
});

// ─── Tax ────────────────────────────────────────────────────────────────────
describe("tax lots", () => {
  it("realises FIFO gains with holding periods", () => {
    const t = buildTaxReport([
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 100, date: "2020-01-01", fees: 0 }),
      trade({ type: "buy", symbol: "AAPL", shares: 10, price: 200, date: "2021-01-01" }),
      trade({ type: "sell", symbol: "AAPL", shares: 12, price: 300, date: "2022-01-01" }),
    ]);
    expect(t.realized).toHaveLength(2);
    const long = t.realized.find((r) => r.term === "long")!;
    const short = t.realized.find((r) => r.term === "short")!;
    expect(long.shares).toBe(10);
    expect(long.gain).toBeCloseTo(2000, 6);
    expect(short.shares).toBe(2);
    expect(short.gain).toBeCloseTo(200, 6);
    expect(t.openLots.reduce((s, l) => s + l.remaining, 0)).toBe(8);
  });

  it("groups realised gains and dividends by tax year", () => {
    const t = buildTaxReport([
      trade({ type: "buy", symbol: "MSFT", shares: 5, price: 100, date: "2020-01-01" }),
      trade({ type: "sell", symbol: "MSFT", shares: 5, price: 150, date: "2024-06-01" }),
      trade({ type: "dividend", symbol: "MSFT", price: 25, date: "2024-03-01" }),
    ]);
    const y2024 = t.years.find((y) => y.year === 2024)!;
    expect(y2024.longTermGain).toBeCloseTo(250, 6);
    expect(y2024.dividends).toBe(25);
    expect(y2024.netGain).toBeCloseTo(250, 6);
  });

  it("supports average cost as an alternative", () => {
    const t = buildTaxReport(
      [
        trade({ type: "buy", symbol: "KO", shares: 10, price: 50, date: "2023-01-01" }),
        trade({ type: "buy", symbol: "KO", shares: 10, price: 70, date: "2023-06-01" }),
        trade({ type: "sell", symbol: "KO", shares: 10, price: 80, date: "2024-06-01" }),
      ],
      "average",
    );
    // Average cost 60 → gain 200, regardless of which lot matched.
    expect(t.realized.reduce((s, r) => s + r.gain, 0)).toBeCloseTo(200, 6);
  });

  it("flags wash sales within 30 days", () => {
    const t = buildTaxReport([
      trade({ type: "buy", symbol: "TSLA", shares: 10, price: 100, date: "2024-01-01" }),
      trade({ type: "sell", symbol: "TSLA", shares: 10, price: 80, date: "2024-06-01" }),
      trade({ type: "buy", symbol: "TSLA", shares: 5, price: 85, date: "2024-06-10" }),
    ]);
    expect(t.washSales).toHaveLength(1);
    expect(t.washSales[0].repurchaseDate).toBe("2024-06-10");
    expect(cleanRepurchaseDate("2024-06-01")).toBe("2024-07-02");
  });
});

describe("harvest candidates", () => {
  it("finds losses above the threshold and warns about recent buys", () => {
    const today = new Date();
    const recent = new Date(today.getTime() - 5 * 86_400_000).toISOString().slice(0, 10);
    const rows = harvestCandidates(
      [
        { symbol: "AAPL", shares: 10, unrealized: -500, unrealizedPct: -20, marketValue: 2000 },
        { symbol: "KO", shares: 10, unrealized: -20, unrealizedPct: -1, marketValue: 1980 },
      ],
      [trade({ type: "buy", symbol: "AAPL", shares: 2, price: 100, date: recent })],
      100,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("AAPL");
    expect(rows[0].washSaleRisk).toBe(true);
  });
});

// ─── Allocation ─────────────────────────────────────────────────────────────
describe("drift and rebalancing", () => {
  const holdings = [
    { symbol: "AAPL", weightPct: 30, marketValue: 600, shares: 6, price: 100, tag: "AAPL" },
    { symbol: "BND", weightPct: 20, marketValue: 400, shares: 4, price: 100, tag: "BND" },
  ];

  it("computes drift, target values and cash", () => {
    const d = driftReport(holdings, { AAPL: 50, Cash: 10 }, 1100, 100);
    expect(d.rows.find((r) => r.key === "AAPL")!.currentPct).toBeCloseTo(54.545, 3);
    expect(d.rows.find((r) => r.key === "AAPL")!.driftPct).toBeCloseTo(4.545, 3);
    expect(d.rows.find((r) => r.key === "BND")!.targetPct).toBe(0);
    expect(d.rows.find((r) => r.key === "Cash")!.targetPct).toBe(10);
    expect(d.targetSumPct).toBe(60);
    expect(d.needsRebalance).toBe(true);
  });

  it("turns dollar targets into share trades", () => {
    const d = driftReport(holdings, { AAPL: 50 }, 1000, 0);
    const trades = rebalanceTrades(d.rows, holdings.map((h) => ({ symbol: h.symbol, price: h.price, weightPct: h.weightPct })));
    const aapl = trades.find((t) => t.symbol === "AAPL")!;
    expect(aapl.side).toBe("sell");
    expect(aapl.shares).toBe(1); // $100 over target ÷ $100/share = 1 share (only 6 are held)
  });
});

describe("weighting schemes", () => {
  it("weights inversely to volatility", () => {
    const w = inverseVolWeights({ A: 20, B: 40, C: null, D: 0 });
    expect(w.A).toBeCloseTo(2 / 3, 10);
    expect(w.B).toBeCloseTo(1 / 3, 10);
    expect(w.C).toBeUndefined();
  });

  it("equalises risk contributions, not just inverse volatility", () => {
    const cov = [
      [0.04, 0],
      [0, 0.09],
    ];
    const rp = riskParityWeights(cov, ["A", "B"]);
    expect(rp.converged).toBe(true);
    expect(rp.weights.A).toBeCloseTo(0.6, 2);
    expect(rp.weights.B).toBeCloseTo(0.4, 2);
    expect(rp.riskContributions.A).toBeCloseTo(0.5, 2);
    expect(rp.riskContributions.B).toBeCloseTo(0.5, 2);
  });

  it("builds an annualised covariance matrix from aligned returns", () => {
    const series: Record<string, Array<{ date: string; ret: number }>> = { A: [], B: [] };
    for (let i = 0; i < 40; i++) {
      const date = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      series.A.push({ date, ret: i % 2 === 0 ? 0.01 : -0.01 });
      series.B.push({ date, ret: i % 2 === 0 ? 0.02 : -0.02 });
    }
    const c = covarianceMatrix(series, ["A", "B"]);
    expect(c.usedSymbols).toEqual(["A", "B"]);
    expect(c.matrix[0][1]).toBeGreaterThan(0);
    expect(c.matrix[1][0]).toBeCloseTo(c.matrix[0][1], 12);
  });
});

describe("Kelly, fees, goals and income", () => {
  it("computes full and half Kelly", () => {
    const k = kellySizing(10, 20, 0.5);
    expect(k.fullKellyPct!).toBeCloseTo(250, 6);
    expect(k.fractionalPct!).toBeCloseTo(125, 6);
    expect(k.note).toContain("leverage");
    expect(kellySizing(-5, 20).fullKellyPct!).toBeLessThan(0);
    expect(kellySizing(5, null).fullKellyPct).toBeNull();
  });

  it("reports fee drag against invested capital and gross P&L", () => {
    const f = feeReport(500, 10_000, 2_000, 2);
    expect(f.feesPctOfInvested!).toBeCloseTo(5, 6);
    expect(f.feesPctOfGrossPnl!).toBeCloseTo(20, 6);
    expect(f.annualDragPct!).toBeCloseTo(2.5, 6);
  });

  it("projects a goal and the required monthly saving", () => {
    const g = goalPlan({ startValue: 0, monthlyContribution: 100, years: 10, expectedReturnPct: 0 });
    expect(g.projectedNominal).toBeCloseTo(12_000, 6);
    const target = goalPlan({ startValue: 0, monthlyContribution: 100, years: 10, expectedReturnPct: 0, target: 24_000 });
    expect(target.requiredMonthly!).toBeCloseTo(200, 0);
    expect(target.onTrack).toBe(false);
    expect(target.gap!).toBeGreaterThan(0);
  });

  it("uses recorded dividends for yield on cost and a seasonal run-rate", () => {
    const i = incomeReport(
      [
        trade({ type: "dividend", symbol: "KO", price: 60, date: "2025-12-01" }),
        trade({ type: "dividend", symbol: "KO", price: 40, date: "2026-06-01" }),
        trade({ type: "dividend", symbol: "KO", price: 30, date: "2025-01-15" }),
      ],
      [{ symbol: "KO", costBasis: 2000, dividends: 100 }],
      2500,
      "2026-10-18",
    );
    expect(i.trailing12m).toBe(100);
    expect(i.prior12m).toBe(30);
    expect(i.yieldOnCostPct!).toBeCloseTo(5, 6);
    expect(i.yieldOnValuePct!).toBeCloseTo(4, 6);
    expect(i.monthlyPattern[11]).toBeCloseTo(0.6, 6);
    expect(i.monthlyPattern[5]).toBeCloseTo(0.4, 6);
    expect(i.projectedNext12m).toBe(100);
    expect(i.incomeLagNote).toContain("run-rate");
  });
});

// ─── Attribution ────────────────────────────────────────────────────────────
describe("attribution", () => {
  it("sums lifetime P&L per holding and shares", () => {
    const c = lifetimeContribution([
      { symbol: "AAPL", shares: 1, unrealized: 500, realized: 100, dividends: 20 },
      { symbol: "KO", shares: 1, unrealized: -200, realized: 0, dividends: 10 },
    ]);
    expect(c.totalPnl).toBe(430);
    expect(c.rows[0].symbol).toBe("AAPL");
    expect(c.winners).toBe(1);
    expect(c.losers).toBe(1);
  });

  it("reconciles the waterfall exactly", () => {
    // Commissions on buys/sells already sit inside cost basis and realised P&L,
    // so only *standalone* fee rows are a separate line — that is what the
    // report passes in as the second argument.
    const totals = { unrealized: 500, realized: 100, dividends: 20, fees: 30, totalReturn: 590 };
    const w = pnlWaterfall(totals, 30);
    expect(w.residual).toBeCloseTo(0, 10);
    expect(w.items.find((i) => i.label === "Total P&L")!.value).toBe(590);
  });

  it("computes period contribution from weights and returns", () => {
    const p = periodContribution(
      [
        { symbol: "A", weightPct: 60 },
        { symbol: "B", weightPct: 40 },
      ],
      {
        A: [
          { date: "2024-01-01", value: 100 },
          { date: "2024-06-01", value: 110 },
        ],
        B: [
          { date: "2024-01-01", value: 100 },
          { date: "2024-06-01", value: 90 },
        ],
      },
      "2024-01-01",
      "2024-06-01",
    );
    expect(p.rows[0].symbol).toBe("A");
    expect(p.rows[0].contributionPct).toBeCloseTo(6, 6);
    expect(p.rows[1].contributionPct).toBeCloseTo(-4, 6);
    expect(p.totalPct).toBeCloseTo(2, 6);
  });
});
