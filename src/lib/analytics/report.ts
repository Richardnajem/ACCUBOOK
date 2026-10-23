// ─── Analytics report assembly ──────────────────────────────────────────────
//
// One pure function turns (ledger, live holdings, cached bars, config) into the
// payload every analytics screen renders. Keeping it pure and free of HTTP/DB
// access is what lets the test-suite feed it a synthetic ledger.
//
// Sections:
//   performance — TWR, XIRR, Dietz, calendar, benchmark, contribution, waterfall
//   risk        — vol/Sharpe/Sortino/Calmar, drawdowns, VaR/CVaR, beta/alpha,
//                 tracking error, correlation, concentration, stress, shocks
//   allocation  — target drift, rebalance plan, inverse-vol, risk parity, Kelly
//   tax         — FIFO/average lots, realised gains by year, wash sales, harvest
//   income      — recorded dividends, yield on cost, run-rate projection
//   planning    — fees, goal projection, Monte Carlo range
//
// Every optional number is null rather than 0, and `warnings` explains why.

import type { Trade } from "../db";
import type { PortfolioSnapshot, QuotedPosition } from "../portfolio";
import type { AnalyticsConfig } from "./config";
import { buildPortfolioHistory } from "./history";
import type { BarLite } from "./history";
import {
  compareToBenchmark,
  dailyTimeWeightedReturns,
  modifiedDietz,
  monthlyReturns,
  rollingReturns,
  timeWeightedReturn,
  xirr,
  yearlyReturns,
} from "./returns";
import type { CashFlow, DatedReturn } from "./returns";
import {
  STRESS_WINDOWS,
  computeRiskMetrics,
  concentrationReport,
  correlationMatrix,
  drawdownSeries,
  monteCarloProjection,
  shockImpact,
  stressTests,
} from "./risk";
import type {
  ConcentrationReport,
  CorrelationReport,
  RiskMetrics,
  StressResult,
} from "./risk";
import {
  annualisedVol,
  covarianceMatrix,
  driftReport,
  feeReport,
  goalPlan,
  incomeReport,
  inverseVolWeights,
  kellySizing,
  rebalanceTrades,
  riskParityWeights,
} from "./allocation";
import type { DriftReport, FeeReport, GoalPlan, IncomeReport, KellyResult } from "./allocation";
import { buildTaxReport, harvestCandidates } from "./tax";
import type { HarvestCandidate, TaxReport } from "./tax";
import { lifetimeContribution, periodContribution, pnlWaterfall } from "./attribution";
import type { ContributionReport, PeriodContribution, WaterfallItem } from "./attribution";
import { returnsFromValues } from "./stats";
import type { BenchmarkComparison, PeriodReturn, YearReturn } from "./returns";

export interface AnalyticsReport {
  generatedAt: string;
  config: AnalyticsConfig;
  dataQuality: {
    historyStart: string | null;
    historyEnd: string | null;
    observations: number;
    benchmarkSymbol: string;
    benchmarkObservations: number;
    hasBenchmark: boolean;
    missingPriceSymbols: string[];
    priceSources: Record<string, string | null>;
    /** True when any series came from an unadjusted source (Nasdaq CSV). */
    hasUnadjustedSource: boolean;
    warnings: string[];
  };
  performance: {
    twrCumulativePct: number | null;
    twrAnnualisedPct: number | null;
    years: number;
    xirrPct: number | null;
    dietzCumulativePct: number | null;
    cagrPct: number | null;
    bestMonth: PeriodReturn | null;
    worstMonth: PeriodReturn | null;
    monthly: PeriodReturn[];
    yearly: YearReturn[];
    benchmark: BenchmarkComparison | null;
    rolling1y: Array<{ date: string; retPct: number }>;
    contribution: ContributionReport;
    waterfall: { items: WaterfallItem[]; residual: number; feesTotal: number; note: string };
    period: PeriodContribution;
    levels: Array<{ date: string; value: number }>;
  };
  risk: {
    metrics: RiskMetrics;
    drawdown: Array<{ date: string; drawdownPct: number }>;
    correlation: CorrelationReport;
    concentration: ConcentrationReport;
    stress: StressResult[];
    shocks: Array<{ shockPct: number; portfolioReturnPct: number; dollarImpact: number }>;
    covarianceSymbols: string[];
    riskParity: {
      weights: Record<string, number>;
      riskContributions: Record<string, number>;
      converged: boolean;
      observations: number;
    };
    inverseVolWeights: Record<string, number>;
  };
  allocation: {
    drift: DriftReport;
    rebalance: Array<{ symbol: string; side: "buy" | "sell"; shares: number; value: number }>;
    tags: Record<string, string>;
    kelly: KellyResult;
  };
  tax: {
    report: TaxReport;
    harvest: HarvestCandidate[];
  };
  income: IncomeReport;
  planning: {
    fees: FeeReport;
    goal: GoalPlan;
    monteCarlo: ReturnType<typeof monteCarloProjection>;
    expectedReturnPctUsed: number;
    volPctUsed: number;
  };
}

export interface ReportInput {
  trades: Trade[];
  snapshot: PortfolioSnapshot;
  quoted: QuotedPosition[];
  bars: Record<string, BarLite[]>;
  priceSources?: Record<string, string | null>;
  benchmarkBars: BarLite[];
  benchmarkSymbol: string;
  config: AnalyticsConfig;
  now?: string;
}

/** Daily returns from a plain close series. */
function barReturns(bars: BarLite[]): DatedReturn[] {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const rets = returnsFromValues(sorted.map((b) => b.close));
  const out: DatedReturn[] = [];
  for (let i = 1; i < sorted.length; i++) out.push({ date: sorted[i].date, ret: rets[i - 1] });
  return out;
}

export function buildAnalyticsReport(input: ReportInput): AnalyticsReport {
  const { trades, snapshot, quoted, config } = input;
  const held = quoted.filter((p) => p.shares > 0);
  const history = buildPortfolioHistory(trades, input.bars);
  const daily = history.daily;
  const levels = history.levels;

  // ── Performance ──
  const twr = timeWeightedReturn(daily);
  const monthly = monthlyReturns(daily);
  const yearly = yearlyReturns(daily);
  const benchReturns = barReturns(input.benchmarkBars);


  const deposits = trades.filter((t) => t.type === "deposit");
  const withdrawals = trades.filter((t) => t.type === "withdrawal");
  const firstFlowDate = [...deposits, ...withdrawals].map((t) => t.date).sort()[0] ?? null;
  const finalEquity = snapshot.totals.equity;
  const flows: CashFlow[] = [
    ...deposits.map((t) => ({ date: t.date, amount: -(t.price ?? 0) })),
    ...withdrawals.map((t) => ({ date: t.date, amount: t.price ?? 0 })),
  ];
  if (finalEquity > 0) flows.push({ date: input.now ?? new Date().toISOString().slice(0, 10), amount: finalEquity });
  const mwr = xirr(flows);

  const dietz =
    firstFlowDate && levels.length >= 2
      ? modifiedDietz(
          0,
          finalEquity,
          [
            ...deposits.map((t) => ({ date: t.date, amount: t.price ?? 0 })),
            ...withdrawals.map((t) => ({ date: t.date, amount: -(t.price ?? 0) })),
          ],
          firstFlowDate,
          input.now ?? new Date().toISOString().slice(0, 10),
        )
      : null;

  const contribution = lifetimeContribution(
    quoted.map((p) => ({
      symbol: p.symbol,
      shares: p.shares,
      unrealized: p.unrealized,
      realized: p.realized,
      dividends: p.dividends,
    })),
  );
  const standaloneFeeRows = trades
    .filter((t) => t.type === "fee")
    .reduce((s, t) => s + Math.abs(t.price ?? 0), 0);
  const waterfall = pnlWaterfall(snapshot.totals, standaloneFeeRows);
  const period = periodContribution(
    held.map((p) => ({ symbol: p.symbol, weightPct: p.weightPct })),
    history.symbolSeries,
    history.startDate,
    history.endDate,
  );

  const benchmark = benchReturns.length >= 2
    ? compareToBenchmark(daily, benchReturns, input.benchmarkSymbol)
    : null;

  // ── Risk ──
  const metrics = computeRiskMetrics(daily, levels, {
    riskFreePct: config.riskFreePct,
    marPct: config.marPct,
    benchmark: benchReturns.length >= 1
      ? { symbol: input.benchmarkSymbol, returns: benchReturns }
      : undefined,
  });
  const correlation = correlationMatrix(history.symbolSeries);
  const concentration = concentrationReport(
    held.map((p) => ({ symbol: p.symbol, weightPct: p.weightPct })),
    config.maxWeightPct,
  );
  const stress = stressTests(
    held.map((p) => ({ symbol: p.symbol, weightPct: p.weightPct })),
    input.bars,
    snapshot.totals.marketValue,
  );

  // Per-symbol daily returns for covariance / risk parity.
  const symbolReturns: Record<string, DatedReturn[]> = {};
  for (const [sym, series] of Object.entries(history.symbolSeries)) {
    const rets = returnsFromValues(series.map((s) => s.value));
    const out: DatedReturn[] = [];
    for (let i = 1; i < series.length; i++) out.push({ date: series[i].date, ret: rets[i - 1] });
    symbolReturns[sym] = out;
  }
  const cov = covarianceMatrix(symbolReturns, history.symbolsUsed);
  const riskParity = cov.usedSymbols.length >= 2
    ? riskParityWeights(cov.matrix, cov.usedSymbols)
    : { weights: {}, riskContributions: {}, converged: false, iterations: 0 };
  const vols: Record<string, number | null> = {};
  for (const sym of history.symbolsUsed) vols[sym] = annualisedVol(symbolReturns[sym] ?? []);

  const shocks = [-10, -20, -30].map((s) => {
    const impact = shockImpact(
      held.map((p) => ({ symbol: p.symbol, weightPct: p.weightPct })),
      s,
    );
    return {
      shockPct: s,
      portfolioReturnPct: impact.portfolioReturnPct,
      dollarImpact: (snapshot.totals.marketValue * impact.portfolioReturnPct) / 100,
    };
  });

  // ── Allocation ──
  const tagged = held.map((p) => ({
    symbol: p.symbol,
    weightPct: p.weightPct,
    marketValue: p.marketValue,
    shares: p.shares,
    price: p.lastPrice,
    tag: config.tags[p.symbol] || "Unclassified",
  }));
  const drift = driftReport(tagged, config.targets, snapshot.totals.equity, snapshot.cashBalance);
  const rebalance = rebalanceTrades(
    drift.rows,
    tagged.map((t) => ({ symbol: t.symbol, price: t.price, weightPct: t.weightPct })),
  );
  const kelly = kellySizing(
    metrics.cagrPct !== null ? metrics.cagrPct - config.riskFreePct : null,
    metrics.annualisedVolPct,
    0.5,
  );

  // ── Tax & income ──
  const taxReport = buildTaxReport(trades, "fifo");
  const harvest = harvestCandidates(held, trades);
  const income = incomeReport(
    trades,
    quoted.map((p) => ({ symbol: p.symbol, costBasis: p.costBasis, dividends: p.dividends })),
    snapshot.totals.marketValue,
    input.now ?? new Date().toISOString().slice(0, 10),
  );

  // ── Planning ──
  const years =
    levels.length >= 2
      ? Math.max(0, (Date.parse(levels[levels.length - 1].date) - Date.parse(levels[0].date)) / (365 * 86_400_000))
      : 0;
  const fees = feeReport(snapshot.totals.fees, snapshot.totals.invested, snapshot.totals.totalReturn, years);
  const goal = goalPlan({
    startValue: snapshot.totals.equity,
    monthlyContribution: config.goal.monthlyContribution,
    years: config.goal.years,
    expectedReturnPct: config.goal.expectedReturnPct,
    inflationPct: config.goal.inflationPct,
    target: config.goal.target,
  });
  const volUsed = metrics.annualisedVolPct ?? 15;
  const mc = monteCarloProjection({
    startValue: snapshot.totals.equity,
    monthlyContribution: config.goal.monthlyContribution,
    years: config.goal.years,
    meanAnnualPct: config.goal.expectedReturnPct,
    volAnnualPct: volUsed,
    simulations: 2000,
    seed: 20261,
  });

  // ── Data quality ──
  const warnings = [...history.warnings];
  if (deposits.length === 0) {
    warnings.push("No deposits recorded — money-weighted return (XIRR) needs at least one funding flow.");
  }
  if (input.benchmarkBars.length < 2) {
    warnings.push(`No cached history for benchmark ${input.benchmarkSymbol}; beta, alpha and tracking error are unavailable.`);
  }
  const sources = input.priceSources ?? {};
  const unadjusted = Object.values(sources).some((s) => (s ?? "").toLowerCase().includes("nasdaq"));
  if (unadjusted) {
    warnings.push(
      "Some price history came from Nasdaq, which is unadjusted: dividends are then missing from the return index. Refresh those symbols from Yahoo to fix it.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    config,
    dataQuality: {
      historyStart: history.startDate,
      historyEnd: history.endDate,
      observations: daily.length,
      benchmarkSymbol: input.benchmarkSymbol,
      benchmarkObservations: benchReturns.length,
      hasBenchmark: benchReturns.length >= 2,
      missingPriceSymbols: history.missingSymbols,
      priceSources: sources,
      hasUnadjustedSource: unadjusted,
      warnings,
    },
    performance: {
      twrCumulativePct: twr.cumulative === null ? null : twr.cumulative * 100,
      twrAnnualisedPct: twr.annualised === null ? null : twr.annualised * 100,
      years: twr.years,
      xirrPct: mwr === null ? null : mwr * 100,
      dietzCumulativePct: dietz === null ? null : dietz * 100,
      cagrPct: metrics.cagrPct,
      bestMonth: monthly.length ? monthly.reduce((a, b) => (b.ret > a.ret ? b : a)) : null,
      worstMonth: monthly.length ? monthly.reduce((a, b) => (b.ret < a.ret ? b : a)) : null,
      monthly,
      yearly,
      benchmark,
      rolling1y: rollingReturns(levels, 252).map((p) => ({ date: p.date, retPct: p.ret * 100 })),
      contribution,
      waterfall,
      period,
      levels,
    },
    risk: {
      metrics,
      drawdown: drawdownSeries(levels),
      correlation,
      concentration,
      stress: stress.slice(0, STRESS_WINDOWS.length),
      shocks,
      covarianceSymbols: cov.usedSymbols,
      riskParity: {
        weights: riskParity.weights,
        riskContributions: riskParity.riskContributions,
        converged: riskParity.converged,
        observations: cov.observations,
      },
      inverseVolWeights: inverseVolWeights(vols),
    },
    allocation: {
      drift,
      rebalance,
      tags: config.tags,
      kelly,
    },
    tax: { report: taxReport, harvest },
    income,
    planning: {
      fees,
      goal,
      monteCarlo: mc,
      expectedReturnPctUsed: config.goal.expectedReturnPct,
      volPctUsed: volUsed,
    },
  };
}
