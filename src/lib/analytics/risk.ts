// ─── Risk analytics ────────────────────────────────────────────────────────
//
// All inputs are *flow-adjusted daily returns* (from returns.ts), so a deposit
// can never masquerade as performance. Conventions are fixed here and repeated
// in the UI tooltips:
//   • volatility / tracking error / downside deviation annualised by √252
//   • Sharpe uses a daily risk-free rate derived from the annual setting
//   • Sortino's target is the annual MAR converted per day, and the downside
//     deviation divides by ALL observations (empyrical convention), so it is
//     not inflated by counting only losing days
//   • VaR/CVaR are one-day, historical (empirical quantile) plus parametric
//   • Calmar = CAGR / |max drawdown| over the same window
// Anything that cannot be computed from the sample is null, never zero.

import {
  TRADING_DAYS,
  annualize,
  correlation,
  mean,
  normalQuantile,
  quantile,
  returnsFromValues,
  sampleCov,
  sampleStd,
  linkReturns,
} from "./stats";
import type { DatedReturn, DatedValue } from "./returns";

export interface DrawdownInfo {
  maxDrawdownPct: number | null;
  peakDate: string | null;
  troughDate: string | null;
  recoveryDate: string | null;
  currentDrawdownPct: number | null;
  /** Longest stretch (calendar days) below the prior high-water mark. */
  longestUnderwaterDays: number | null;
  underwaterNowDays: number | null;
}

/** Running-peak drawdown series, in percent (0 = at a high). */
export function drawdownSeries(points: DatedValue[]): Array<{ date: string; drawdownPct: number }> {
  let peak = -Infinity;
  const out: Array<{ date: string; drawdownPct: number }> = [];
  for (const p of points) {
    if (p.value > peak) peak = p.value;
    if (!(peak > 0)) continue;
    out.push({ date: p.date, drawdownPct: (p.value / peak - 1) * 100 });
  }
  return out;
}

export function drawdownInfo(points: DatedValue[]): DrawdownInfo {
  let peak = -Infinity;
  let peakDate: string | null = null;
  let maxDd = 0;
  let ddPeakDate: string | null = null;
  let troughDate: string | null = null;
  let recoveryDate: string | null = null;
  let underwaterStart: string | null = null;
  let longest = 0;
  let currentUnderwaterStart: string | null = null;

  const dayDiff = (a: string, b: string) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

  for (const p of points) {
    if (p.value >= peak) {
      if (underwaterStart && peakDate) {
        longest = Math.max(longest, dayDiff(underwaterStart, p.date));
      }
      underwaterStart = null;
      currentUnderwaterStart = null;
      peak = p.value;
      peakDate = p.date;
      continue;
    }
    if (!(peak > 0)) continue;
    if (underwaterStart === null) underwaterStart = p.date;
    if (currentUnderwaterStart === null) currentUnderwaterStart = p.date;
    const dd = p.value / peak - 1;
    if (dd < maxDd) {
      maxDd = dd;
      ddPeakDate = peakDate;
      troughDate = p.date;
      recoveryDate = null;
    }
  }
  if (troughDate && ddPeakDate) {
    const peakValue = points.find((p) => p.date === ddPeakDate)?.value ?? null;
    if (peakValue !== null) {
      recoveryDate = points.find((p) => p.date > troughDate && p.value >= peakValue)?.date ?? null;
    }
  }
  if (underwaterStart && points.length) {
    longest = Math.max(longest, dayDiff(underwaterStart, points[points.length - 1].date));
  }

  const last = points[points.length - 1];
  const lastPeak = (() => {
    let m = -Infinity;
    for (const p of points) m = Math.max(m, p.value);
    return m;
  })();

  return {
    maxDrawdownPct: points.length ? maxDd * 100 : null,
    peakDate: ddPeakDate,
    troughDate,
    recoveryDate,
    currentDrawdownPct: last && lastPeak > 0 ? (last.value / lastPeak - 1) * 100 : null,
    longestUnderwaterDays: points.length ? longest : null,
    underwaterNowDays:
      currentUnderwaterStart && last ? Math.max(0, dayDiff(currentUnderwaterStart, last.date)) : 0,
  };
}

/** Ulcer Index: RMS of percentage drawdowns (depth × duration). */
export function ulcerIndex(dd: Array<{ drawdownPct: number }>): number | null {
  if (dd.length === 0) return null;
  let s = 0;
  for (const d of dd) s += d.drawdownPct * d.drawdownPct;
  return Math.sqrt(s / dd.length);
}

export interface RiskMetrics {
  observations: number;
  startDate: string | null;
  endDate: string | null;
  years: number;
  totalReturnPct: number | null;
  cagrPct: number | null;
  annualisedVolPct: number | null;
  downsideDeviationPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdownPct: number | null;
  maxDrawdownPeak: string | null;
  maxDrawdownTrough: string | null;
  recoveryDate: string | null;
  currentDrawdownPct: number | null;
  longestUnderwaterDays: number | null;
  ulcerIndex: number | null;
  martinRatio: number | null;
  var95Pct: number | null;
  var99Pct: number | null;
  cvar95Pct: number | null;
  cvar99Pct: number | null;
  parametricVar95Pct: number | null;
  parametricVar99Pct: number | null;
  beta: number | null;
  alphaAnnualPct: number | null;
  treynor: number | null;
  rSquared: number | null;
  trackingErrorPct: number | null;
  informationRatio: number | null;
  bestDayPct: number | null;
  worstDayPct: number | null;
  positiveDaysPct: number | null;
  annualisedMeanPct: number | null;
}

export interface RiskOptions {
  riskFreePct?: number;
  /** minimum acceptable annual return for Sortino */
  marPct?: number;
  benchmark?: { symbol: string; returns: DatedReturn[] };
}

const ci = (x: number | null, scale = 100): number | null =>
  x === null || !Number.isFinite(x) ? null : x * scale;

export function computeRiskMetrics(
  daily: DatedReturn[],
  values: DatedValue[],
  opts: RiskOptions = {},
): RiskMetrics {
  const rfAnnual = (opts.riskFreePct ?? 0) / 100;
  const marAnnual = (opts.marPct ?? 0) / 100;
  const rfDaily = Math.pow(1 + rfAnnual, 1 / TRADING_DAYS) - 1;
  const marDaily = Math.pow(1 + marAnnual, 1 / TRADING_DAYS) - 1;

  const rets = daily.map((d) => d.ret);
  const n = rets.length;
  const startDate = daily[0]?.date ?? values[0]?.date ?? null;
  const endDate = daily[daily.length - 1]?.date ?? values[values.length - 1]?.date ?? null;
  const years = startDate && endDate
    ? Math.max(0, (Date.parse(endDate) - Date.parse(startDate)) / (365 * 86_400_000))
    : 0;

  const total = linkReturns(rets);
  const sd = sampleStd(rets);
  const m = mean(rets);
  const vol = sd;
  const ddInfo = drawdownInfo(values);
  const dd = drawdownSeries(values);
  const ulcer = ulcerIndex(dd);

  const cagr = total !== null && years >= 1 ? annualize(total, years) : null;

  // Downside deviation against the daily MAR, all observations in the divisor.
  let downside: number | null = null;
  if (n >= 2) {
    let s = 0;
    for (const r of rets) {
      const short = Math.min(0, r - marDaily);
      s += short * short;
    }
    downside = Math.sqrt(s / n);
  }

  // A pathologically tiny standard deviation (a constant series) makes the
  // ratio explode; require a real dispersion before reporting one.
  const MIN_DISPERSION = 1e-8;
  const sharpe =
    sd !== null && sd > MIN_DISPERSION && m !== null ? ((m - rfDaily) / sd) * Math.sqrt(TRADING_DAYS) : null;
  const sortino =
    downside !== null && downside > MIN_DISPERSION && m !== null
      ? ((m - marDaily) / downside) * Math.sqrt(TRADING_DAYS)
      : null;
  const calmar =
    cagr !== null && ddInfo.maxDrawdownPct !== null && ddInfo.maxDrawdownPct < 0
      ? cagr / Math.abs(ddInfo.maxDrawdownPct / 100)
      : null;

  const q05 = quantile(rets, 0.05);
  const q01 = quantile(rets, 0.01);
  const var95 = q05 === null ? null : -q05;
  const var99 = q01 === null ? null : -q01;
  const tail95 = q05 === null ? [] : rets.filter((r) => r <= q05);
  const tail99 = q01 === null ? [] : rets.filter((r) => r <= q01);
  const mTail95 = mean(tail95);
  const mTail99 = mean(tail99);
  const cvar95 = mTail95 === null ? null : -mTail95;
  const cvar99 = mTail99 === null ? null : -mTail99;
  const parametric95 = m !== null && sd !== null ? -(m + normalQuantile(0.05) * sd) : null;
  const parametric99 = m !== null && sd !== null ? -(m + normalQuantile(0.01) * sd) : null;

  // Benchmarked risk
  let beta: number | null = null;
  let alphaAnnual: number | null = null;
  let treynor: number | null = null;
  let rSquared: number | null = null;
  let trackingError: number | null = null;
  let infoRatio: number | null = null;
  if (opts.benchmark && opts.benchmark.returns.length > 1) {
    const byDate = new Map(opts.benchmark.returns.map((b) => [b.date, b.ret]));
    const pairs: Array<{ p: number; b: number }> = [];
    for (const d of daily) {
      const b = byDate.get(d.date);
      if (b !== undefined) pairs.push({ p: d.ret, b });
    }
    const p = pairs.map((x) => x.p);
    const b = pairs.map((x) => x.b);
    const cov = sampleCov(p, b);
    const varB = sampleStd(b);
    if (cov !== null && varB !== null && varB > 0) {
      beta = cov / (varB * varB);
      const mp = mean(p);
      const mb = mean(b);
      if (mp !== null && mb !== null) {
        alphaAnnual = (mp - rfDaily - beta * (mb - rfDaily)) * TRADING_DAYS;
        const excessAnnual = (mp - rfDaily) * TRADING_DAYS;
        treynor = beta !== 0 ? excessAnnual / beta : null;
        const corr = correlation(p, b);
        rSquared = corr === null ? null : corr * corr;
      }
      const active = pairs.map((x) => x.p - x.b);
      const activeSd = sampleStd(active);
      const activeMean = mean(active);
      if (activeSd !== null) trackingError = activeSd * Math.sqrt(TRADING_DAYS);
      if (activeSd !== null && activeSd > 0 && activeMean !== null) {
        infoRatio = (activeMean * TRADING_DAYS) / (activeSd * Math.sqrt(TRADING_DAYS));
      }
    }
  }

  return {
    observations: n,
    startDate,
    endDate,
    years,
    totalReturnPct: ci(total),
    cagrPct: ci(cagr),
    annualisedVolPct: ci(vol === null ? null : vol * Math.sqrt(TRADING_DAYS)),
    downsideDeviationPct: ci(downside === null ? null : downside * Math.sqrt(TRADING_DAYS)),
    sharpe,
    sortino,
    calmar,
    maxDrawdownPct: ddInfo.maxDrawdownPct,
    maxDrawdownPeak: ddInfo.peakDate,
    maxDrawdownTrough: ddInfo.troughDate,
    recoveryDate: ddInfo.recoveryDate,
    currentDrawdownPct: ddInfo.currentDrawdownPct,
    longestUnderwaterDays: ddInfo.longestUnderwaterDays,
    ulcerIndex: ulcer,
    martinRatio:
      ulcer !== null && ulcer > 0 && cagr !== null ? ((cagr - rfAnnual) * 100) / ulcer : null,
    var95Pct: ci(var95),
    var99Pct: ci(var99),
    cvar95Pct: ci(cvar95),
    cvar99Pct: ci(cvar99),
    parametricVar95Pct: ci(parametric95),
    parametricVar99Pct: ci(parametric99),
    beta,
    alphaAnnualPct: ci(alphaAnnual),
    treynor,
    rSquared,
    trackingErrorPct: ci(trackingError),
    informationRatio: infoRatio,
    bestDayPct: rets.length ? Math.max(...rets) * 100 : null,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : null,
    positiveDaysPct: rets.length ? (rets.filter((r) => r > 0).length / rets.length) * 100 : null,
    annualisedMeanPct: ci(m === null ? null : m * TRADING_DAYS),
  };
}

// ─── Correlation ───────────────────────────────────────────────────────────

export interface CorrelationReport {
  symbols: string[];
  matrix: Array<Array<number | null>>;
  topPairs: Array<{ a: string; b: string; correlation: number }>;
  observations: number;
}

/**
 * Pairwise correlation of daily returns on the dates both series share.
 * Requires at least 20 overlapping observations per pair; otherwise null.
 */
export function correlationMatrix(series: Record<string, DatedValue[]>, minObs = 20): CorrelationReport {
  const symbols = Object.keys(series).sort();
  const retsBySymbol: Record<string, Map<string, number>> = {};
  for (const s of symbols) {
    const vals = [...series[s]].sort((a, b) => a.date.localeCompare(b.date));
    const rs = returnsFromValues(vals.map((v) => v.value));
    const map = new Map<string, number>();
    for (let i = 1; i < vals.length; i++) map.set(vals[i].date, rs[i - 1]);
    retsBySymbol[s] = map;
  }

  const matrix: Array<Array<number | null>> = symbols.map(() => symbols.map(() => null));
  const topPairs: Array<{ a: string; b: string; correlation: number }> = [];
  let maxObs = 0;

  for (let i = 0; i < symbols.length; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < symbols.length; j++) {
      const a = retsBySymbol[symbols[i]];
      const b = retsBySymbol[symbols[j]];
      const xa: number[] = [];
      const xb: number[] = [];
      for (const [date, ra] of a) {
        const rb = b.get(date);
        if (rb === undefined) continue;
        xa.push(ra);
        xb.push(rb);
      }
      if (xa.length < minObs) continue;
      const c = correlation(xa, xb);
      if (c === null) continue;
      matrix[i][j] = c;
      matrix[j][i] = c;
      topPairs.push({ a: symbols[i], b: symbols[j], correlation: c });
      maxObs = Math.max(maxObs, xa.length);
    }
  }

  topPairs.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation));
  return { symbols, matrix, topPairs, observations: maxObs };
}

// ─── Concentration ─────────────────────────────────────────────────────────

export interface ConcentrationReport {
  positions: number;
  hhi: number | null;
  effectivePositions: number | null;
  top1Pct: number | null;
  top5Pct: number | null;
  largestSymbol: string | null;
  /** Positions above the single-name guardrail. */
  breaches: Array<{ symbol: string; weightPct: number }>;
}

export function concentrationReport(
  holdings: Array<{ symbol: string; weightPct: number }>,
  maxWeightPct = 25,
): ConcentrationReport {
  const rows = [...holdings].sort((a, b) => b.weightPct - a.weightPct);
  const fractions = rows.map((r) => r.weightPct / 100);
  let h = 0;
  for (const f of fractions) h += f * f;
  return {
    positions: rows.length,
    hhi: fractions.length ? h : null,
    effectivePositions: h > 0 ? 1 / h : null,
    top1Pct: rows[0]?.weightPct ?? null,
    top5Pct: rows.slice(0, 5).reduce((s, r) => s + r.weightPct, 0),
    largestSymbol: rows[0]?.symbol ?? null,
    breaches: rows.filter((r) => r.weightPct > maxWeightPct).map((r) => ({ symbol: r.symbol, weightPct: r.weightPct })),
  };
}

// ─── Stress tests ──────────────────────────────────────────────────────────

export interface StressWindow {
  id: string;
  label: string;
  start: string;
  end: string;
  note: string;
}

export const STRESS_WINDOWS: StressWindow[] = [
  {
    id: "dotcom",
    label: "Dot-com bust",
    start: "2000-03-24",
    end: "2002-10-09",
    note: "S&P 500 peak to trough; tech-heavy portfolios fell further.",
  },
  {
    id: "gfc",
    label: "Global financial crisis",
    start: "2007-10-09",
    end: "2009-03-09",
    note: "S&P 500 peak to trough; financials led the decline.",
  },
  {
    id: "q4-2018",
    label: "Q4 2018 sell-off",
    start: "2018-09-20",
    end: "2018-12-24",
    note: "Rate-scare drawdown across growth names.",
  },
  {
    id: "covid",
    label: "COVID crash",
    start: "2020-02-19",
    end: "2020-03-23",
    note: "Fastest 30%+ index drawdown on record.",
  },
  {
    id: "rates-2022",
    label: "2022 rate shock",
    start: "2022-01-03",
    end: "2022-10-12",
    note: "Inflation and rate rises hit long-duration equities and bonds.",
  },
];

export interface StressResult {
  id: string;
  label: string;
  note: string;
  start: string;
  end: string;
  portfolioReturnPct: number | null;
  dollarImpact: number | null;
  coveredWeightPct: number;
  perSymbol: Array<{ symbol: string; returnPct: number | null; weightPct: number; contributionPct: number | null }>;
  missingSymbols: string[];
}

function priceOnOrBefore(bars: Array<{ date: string; close: number }>, date: string): number | null {
  let found: number | null = null;
  for (const b of bars) {
    if (b.date <= date) found = b.close;
    else break;
  }
  return found;
}

/**
 * Replay historical windows on *today's* holdings: each symbol's actual price
 * return across the window, weighted by current portfolio weight. This answers
 * "what would today's portfolio have done", not "what did my account do then"
 * (which needs historical holdings and is not available).
 */
export function stressTests(
  holdings: Array<{ symbol: string; weightPct: number }>,
  barsBySymbol: Record<string, Array<{ date: string; close: number }>>,
  marketValue: number,
  windows: StressWindow[] = STRESS_WINDOWS,
): StressResult[] {
  return windows.map((w) => {
    const perSymbol: StressResult["perSymbol"] = [];
    const missing: string[] = [];
    let covered = 0;
    let weighted = 0;
    let coverageKnown = false;

    for (const h of holdings) {
      const bars = barsBySymbol[h.symbol];
      const start = bars ? priceOnOrBefore(bars, w.start) : null;
      const end = bars ? priceOnOrBefore(bars, w.end) : null;
      const ret = start && end && start > 0 ? end / start - 1 : null;
      if (ret === null) {
        missing.push(h.symbol);
        perSymbol.push({ symbol: h.symbol, returnPct: null, weightPct: h.weightPct, contributionPct: null });
        continue;
      }
      coverageKnown = true;
      covered += h.weightPct;
      const contribution = (h.weightPct / 100) * ret * 100;
      weighted += contribution;
      perSymbol.push({
        symbol: h.symbol,
        returnPct: ret * 100,
        weightPct: h.weightPct,
        contributionPct: contribution,
      });
    }

    // Renormalise over the symbols we could actually price, so a single missing
    // ticker does not silently halve the scenario.
    const portfolioReturnPct = coverageKnown && covered > 0 ? (weighted / covered) * 100 : null;
    return {
      id: w.id,
      label: w.label,
      note: w.note,
      start: w.start,
      end: w.end,
      portfolioReturnPct,
      dollarImpact: portfolioReturnPct === null ? null : (marketValue * portfolioReturnPct) / 100,
      coveredWeightPct: covered,
      perSymbol: perSymbol.sort((a, b) => (a.returnPct ?? 0) - (b.returnPct ?? 0)),
      missingSymbols: missing,
    };
  });
}

/**
 * Hypothetical shock: market moves by `shockPct`, each name moves by
 * shock × beta (beta defaults to 1 when unknown).
 */
export function shockImpact(
  holdings: Array<{ symbol: string; weightPct: number; beta?: number | null }>,
  shockPct: number,
): { portfolioReturnPct: number; dollarImpactPer100k: number } {
  let r = 0;
  for (const h of holdings) {
    const b = h.beta == null || !Number.isFinite(h.beta) ? 1 : h.beta;
    r += (h.weightPct / 100) * (shockPct / 100) * b;
  }
  // Weights sum to less than 100% when cash is held; cash does not move, so the
  // portfolio shock is simply the weighted sum — no renormalisation.
  const pct = r * 100;
  return { portfolioReturnPct: pct, dollarImpactPer100k: pct * 1000 };
}

// ─── Monte Carlo ───────────────────────────────────────────────────────────

export interface ProjectionPoint {
  year: number;
  p10: number;
  p50: number;
  p90: number;
  contributed: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  finalP10: number;
  finalP50: number;
  finalP90: number;
  contributed: number;
  /** Share of paths that end below total contributions. */
  probabilityBelowContributionsPct: number;
  simulations: number;
  assumptions: {
    startValue: number;
    monthlyContribution: number;
    years: number;
    meanAnnualPct: number;
    volAnnualPct: number;
    seed: number;
  };
}

/**
 * Monthly-step Monte Carlo on log-normal returns. Deterministic for a given
 * seed so the same page reload shows the same bands. `meanAnnualPct` and
 * `volAnnualPct` are *assumptions* — the UI labels them as such.
 */
export function monteCarloProjection(input: {
  startValue: number;
  monthlyContribution: number;
  years: number;
  meanAnnualPct: number;
  volAnnualPct: number;
  simulations?: number;
  seed?: number;
}): ProjectionResult {
  const simulations = Math.min(20_000, Math.max(100, input.simulations ?? 2000));
  const years = Math.max(1, Math.min(60, Math.round(input.years)));
  const months = years * 12;
  const seed = input.seed ?? 12345;
  const muMonthly = Math.pow(1 + input.meanAnnualPct / 100, 1 / 12) - 1;
  const sigmaMonthly = (input.volAnnualPct / 100) / Math.sqrt(12);

  // Store each path's value at every year-end (years+1 columns, not per month).
  const paths: number[][] = Array.from({ length: simulations }, () => new Array(years + 1).fill(0));

  // mulberry32 + Box–Muller, local so the module stays dependency-free.
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(1e-12, rand());
    const v = Math.max(1e-12, rand());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  for (let s = 0; s < simulations; s++) {
    let value = input.startValue;
    paths[s][0] = value;
    for (let mth = 1; mth <= months; mth++) {
      const r = muMonthly + sigmaMonthly * normal();
      value = Math.max(0, value * (1 + r) + input.monthlyContribution);
      if (mth % 12 === 0) paths[s][mth / 12] = value;
    }
  }

  const contributedAt = (year: number) => input.startValue + input.monthlyContribution * year * 12;
  const points: ProjectionPoint[] = [];
  for (let y = 0; y <= years; y++) {
    const col = paths.map((p) => p[y]).sort((a, b) => a - b);
    const at = (q: number) => col[Math.min(col.length - 1, Math.floor(q * (col.length - 1)))];
    points.push({ year: y, p10: at(0.1), p50: at(0.5), p90: at(0.9), contributed: contributedAt(y) });
  }

  const finalValues = points[years];
  const contributed = contributedAt(years);
  const below = paths.filter((p) => p[years] < contributed).length;
  return {
    points,
    finalP10: finalValues.p10,
    finalP50: finalValues.p50,
    finalP90: finalValues.p90,
    contributed,
    probabilityBelowContributionsPct: (below / simulations) * 100,
    simulations,
    assumptions: {
      startValue: input.startValue,
      monthlyContribution: input.monthlyContribution,
      years,
      meanAnnualPct: input.meanAnnualPct,
      volAnnualPct: input.volAnnualPct,
      seed,
    },
  };
}
