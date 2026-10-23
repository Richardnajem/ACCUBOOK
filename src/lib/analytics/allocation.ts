// ─── Allocation, rebalancing, sizing, income and planning ───────────────────
//
// These are constructive tools: they answer "what would bring the portfolio
// back to target" rather than pretending to know future returns. Every
// assumption (expected return, volatility, MAR) is surfaced in the output and
// editable in the UI.

import type { Trade } from "../db";
import { TRADING_DAYS, addDays, mean, sampleStd } from "./stats";
import type { DatedReturn } from "./returns";

export interface WeightedHolding {
  symbol: string;
  weightPct: number;
  marketValue: number;
  shares: number;
  price: number | null;
  /** User-assigned group (sector, asset class, account…). */
  tag: string;
}

export interface DriftRow {
  key: string;
  targetPct: number;
  currentPct: number;
  driftPct: number;
  currentValue: number;
  targetValue: number;
  /** + buy, − sell, in dollars. */
  tradeValue: number;
  action: "buy" | "sell" | "hold";
}

export interface DriftReport {
  rows: DriftRow[];
  totalValue: number;
  cashPct: number;
  maxDriftPct: number;
  needsRebalance: boolean;
  targetSumPct: number;
}

/**
 * Compare live weights to user targets. Targets are per group (tag); the cash
 * target is optional and defaults to 0%. Missing groups get a 0% target so an
 * unclassified position is visible rather than silently ignored.
 */
export function driftReport(
  holdings: WeightedHolding[],
  targets: Record<string, number>,
  totalValue: number,
  cashValue = 0,
  tolerancePct = 2,
): DriftReport {
  const byKey = new Map<string, number>();
  for (const h of holdings) {
    const key = h.tag || "Unclassified";
    byKey.set(key, (byKey.get(key) ?? 0) + h.marketValue);
  }
  if (cashValue > 0) byKey.set("Cash", (byKey.get("Cash") ?? 0) + cashValue);

  const keys = new Set<string>([...Object.keys(targets), ...byKey.keys()]);
  const rows: DriftRow[] = [];
  for (const key of [...keys].sort()) {
    const currentValue = byKey.get(key) ?? 0;
    const targetPct = targets[key] ?? 0;
    const currentPct = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
    const targetValue = (targetPct / 100) * totalValue;
    const tradeValue = targetValue - currentValue;
    const drift = currentPct - targetPct;
    rows.push({
      key,
      targetPct,
      currentPct,
      driftPct: drift,
      currentValue,
      targetValue,
      tradeValue,
      action: Math.abs(tradeValue) < 1 ? "hold" : tradeValue > 0 ? "buy" : "sell",
    });
  }

  const targetSumPct = Object.values(targets).reduce((s, v) => s + v, 0);
  return {
    rows,
    totalValue,
    cashPct: totalValue > 0 ? (cashValue / totalValue) * 100 : 0,
    maxDriftPct: rows.reduce((m, r) => Math.max(m, Math.abs(r.driftPct)), 0),
    needsRebalance: rows.some((r) => Math.abs(r.driftPct) > tolerancePct),
    targetSumPct,
  };
}

/**
 * Turn dollar targets into share counts at the last price. Rounding is toward
 * the target (buys round down, sells round up) so the plan never overshoots
 * available cash; `residual` shows what rounding left over.
 */
export function rebalanceTrades(
  rows: DriftRow[],
  holdings: Array<{ symbol: string; price: number | null; weightPct: number }>,
): Array<{ symbol: string; side: "buy" | "sell"; shares: number; value: number }> {
  const out: Array<{ symbol: string; side: "buy" | "sell"; shares: number; value: number }> = [];
  for (const r of rows) {
    if (r.action === "hold") continue;
    // Only single securities can be traded; group targets are advisory unless a
    // group maps to one symbol.
    const h = holdings.find((x) => x.symbol === r.key);
    if (!h || !h.price || h.price <= 0) continue;
    const raw = Math.abs(r.tradeValue) / h.price;
    const shares = r.action === "buy" ? Math.floor(raw) : Math.ceil(raw);
    if (shares <= 0) continue;
    out.push({
      symbol: h.symbol,
      side: r.action,
      shares,
      value: shares * h.price * (r.action === "buy" ? 1 : -1),
    });
  }
  return out;
}

// ─── Weighting schemes ─────────────────────────────────────────────────────

/** Inverse-volatility weights (ignores correlation — not equal risk). */
export function inverseVolWeights(volPct: Record<string, number | null>): Record<string, number> {
  const entries = Object.entries(volPct).filter(([, v]) => v !== null && v > 0) as Array<[string, number]>;
  const total = entries.reduce((s, [, v]) => s + 1 / v, 0);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const [sym, v] of entries) out[sym] = (1 / v) / total;
  return out;
}

export interface RiskParityResult {
  weights: Record<string, number>;
  iterations: number;
  converged: boolean;
  /** Share of total risk contributed by each asset at the solution. */
  riskContributions: Record<string, number>;
}

/**
 * Equal-risk-contribution weights from a covariance matrix.
 * Fixed point: wᵢ ← wᵢ · (σ_p/N)/RCᵢ, renormalise, repeat. Slower than a
 * Newton solve but dependency-free and monotone for positive covariances.
 */
export function riskParityWeights(
  covariance: number[][],
  symbols: string[],
  iterations = 2000,
  tolerance = 1e-9,
): RiskParityResult {
  const n = symbols.length;
  if (n === 0) return { weights: {}, iterations: 0, converged: false, riskContributions: {} };
  if (n === 1) return { weights: { [symbols[0]]: 1 }, iterations: 0, converged: true, riskContributions: { [symbols[0]]: 1 } };

  let w = new Array(n).fill(1 / n);
  let converged = false;
  let used = 0;
  for (let it = 0; it < iterations; it++) {
    used = it + 1;
    const sigmaW = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) sigmaW[i] += covariance[i][j] * w[j];
    }
    const variance = w.reduce((s, wi, i) => s + wi * sigmaW[i], 0);
    const sigmaP = Math.sqrt(Math.max(variance, 0));
    if (!(sigmaP > 0)) break;
    const rc = w.map((wi, i) => (wi * sigmaW[i]) / sigmaP);
    const target = sigmaP / n;
    // Damped multiplicative update: a full step (exponent 1) oscillates on
    // correlated matrices, sqrt-damping converges monotonically in practice.
    const next = w.map((wi, i) =>
      rc[i] > 1e-14 ? wi * Math.sqrt(target / rc[i]) : wi * 1.02,
    );
    const totalNext = next.reduce((s, v) => s + v, 0);
    if (totalNext <= 0) break;
    const normalized = next.map((v) => v / totalNext);
    const delta = normalized.reduce((s, v, i) => s + Math.abs(v - w[i]), 0);
    w = normalized;
    if (delta < tolerance) {
      converged = true;
      break;
    }
  }

  const sigmaW = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sigmaW[i] += covariance[i][j] * w[j];
  const variance = w.reduce((s, wi, i) => s + wi * sigmaW[i], 0);
  const sigmaP = Math.sqrt(Math.max(variance, 0));
  const riskContributions: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    riskContributions[symbols[i]] = sigmaP > 0 ? (w[i] * sigmaW[i]) / sigmaP / sigmaP : 0;
  }
  const weights: Record<string, number> = {};
  for (let i = 0; i < n; i++) weights[symbols[i]] = w[i];
  return { weights, iterations: used, converged, riskContributions };
}

/** Covariance matrix (daily returns → annualised) from aligned symbol series. */
export function covarianceMatrix(
  returnsBySymbol: Record<string, DatedReturn[]>,
  symbols: string[],
): { matrix: number[][]; usedSymbols: string[]; observations: number } {
  const maps = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    const m = new Map<string, number>();
    for (const r of returnsBySymbol[s] ?? []) m.set(r.date, r.ret);
    maps.set(s, m);
  }
  const usedSymbols = symbols.filter((s) => (maps.get(s)?.size ?? 0) >= 20);
  const matrix: number[][] = usedSymbols.map(() => usedSymbols.map(() => 0));
  let observations = 0;

  for (let i = 0; i < usedSymbols.length; i++) {
    for (let j = i; j < usedSymbols.length; j++) {
      const mi = maps.get(usedSymbols[i])!;
      const mj = maps.get(usedSymbols[j])!;
      const a: number[] = [];
      const b: number[] = [];
      for (const [date, ra] of mi) {
        const rb = mj.get(date);
        if (rb === undefined) continue;
        a.push(ra);
        b.push(rb);
      }
      let cov = 0;
      if (a.length >= 20) {
        const ma = mean(a) ?? 0;
        const mb = mean(b) ?? 0;
        let s = 0;
        for (let k = 0; k < a.length; k++) s += (a[k] - ma) * (b[k] - mb);
        cov = s / (a.length - 1);
        observations = Math.max(observations, a.length);
      }
      // Annualise variance/covariance by 252.
      matrix[i][j] = cov * TRADING_DAYS;
      matrix[j][i] = cov * TRADING_DAYS;
    }
  }
  return { matrix, usedSymbols, observations };
}

/** Annualised volatility (%) from daily returns. */
export function annualisedVol(daily: DatedReturn[]): number | null {
  const sd = sampleStd(daily.map((d) => d.ret));
  return sd === null ? null : sd * Math.sqrt(TRADING_DAYS) * 100;
}

// ─── Kelly sizing ──────────────────────────────────────────────────────────

export interface KellyResult {
  fullKellyPct: number | null;
  fractionalPct: number | null;
  fraction: number;
  note: string;
}

/**
 * Kelly for a single risky allocation: f* ≈ μ/σ² using the *excess* annual
 * arithmetic return. Unconstrained Kelly routinely implies >100% (leverage),
 * so the raw value is reported but the fractional number is what the UI uses.
 */
export function kellySizing(
  annualExcessReturnPct: number | null,
  annualVolPct: number | null,
  fraction = 0.5,
): KellyResult {
  if (annualExcessReturnPct === null || annualVolPct === null || annualVolPct <= 0) {
    return { fullKellyPct: null, fractionalPct: null, fraction, note: "needs a benchmark-relative excess return and a volatility estimate" };
  }
  const mu = annualExcessReturnPct / 100;
  const variance = (annualVolPct / 100) ** 2;
  const full = (mu / variance) * 100;
  return {
    fullKellyPct: full,
    fractionalPct: full * fraction,
    fraction,
    note:
      full > 100
        ? "Full Kelly exceeds 100% — that is leverage; use the fractional figure as a ceiling, not a target."
        : "Half-Kelly is a common compromise between growth and drawdown; estimates of μ are noisy.",
  };
}

// ─── Income ────────────────────────────────────────────────────────────────

export interface DividendEvent {
  date: string;
  symbol: string | null;
  amount: number;
}

export interface IncomeReport {
  trailing12m: number;
  prior12m: number;
  growthPct: number | null;
  yieldOnCostPct: number | null;
  yieldOnValuePct: number | null;
  costBasis: number;
  marketValue: number;
  bySymbol: Array<{ symbol: string; trailing12m: number; sharePct: number }>;
  /** Average share of the annual total paid in each calendar month (0..1). */
  monthlyPattern: number[];
  /** Run-rate projection: trailing 12m repeated, allocated by the pattern. */
  projectedMonthly: number[];
  projectedNext12m: number;
  incomeLagNote: string;
  eventsLast12m: DividendEvent[];
}

const DAY_MS = 86_400_000;

/**
 * Dividend income from *recorded* payments only. The projection is a run-rate
 * (last 12 months repeated, split by the observed seasonal pattern) — not an
 * announced forecast, because the app has no dividend-declaration feed.
 */
export function incomeReport(
  trades: Trade[],
  positions: Array<{ symbol: string; costBasis: number; dividends: number }>,
  marketValue: number,
  today = new Date().toISOString().slice(0, 10),
): IncomeReport {
  const divs = trades
    .filter((t) => t.type === "dividend" && t.price)
    .map((t) => ({ date: t.date, symbol: t.symbol, amount: t.price ?? 0 }));
  const now = Date.parse(today);
  const from = new Date(now - 365 * DAY_MS).toISOString().slice(0, 10);
  const priorFrom = new Date(now - 730 * DAY_MS).toISOString().slice(0, 10);

  const trailing = divs.filter((d) => d.date >= from && d.date <= today);
  const prior = divs.filter((d) => d.date >= priorFrom && d.date < from);
  const ttm = trailing.reduce((s, d) => s + d.amount, 0);
  const prev = prior.reduce((s, d) => s + d.amount, 0);

  const bySymbolMap = new Map<string, number>();
  for (const d of trailing) {
    const k = d.symbol ?? "Unattributed";
    bySymbolMap.set(k, (bySymbolMap.get(k) ?? 0) + d.amount);
  }
  const bySymbol = [...bySymbolMap.entries()]
    .map(([symbol, amount]) => ({ symbol, trailing12m: amount, sharePct: ttm > 0 ? (amount / ttm) * 100 : 0 }))
    .sort((a, b) => b.trailing12m - a.trailing12m);

  const monthTotals = new Array(12).fill(0);
  for (const d of trailing) {
    const m = Number(d.date.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) monthTotals[m] += d.amount;
  }
  const monthlyPattern = monthTotals.map((v) => (ttm > 0 ? v / ttm : 0));
  const projectedMonthly = monthlyPattern.map((p) => p * ttm);

  const costBasis = positions.reduce((s, p) => s + p.costBasis, 0);
  return {
    trailing12m: ttm,
    prior12m: prev,
    growthPct: prev > 0 ? (ttm / prev - 1) * 100 : null,
    yieldOnCostPct: costBasis > 0 ? (ttm / costBasis) * 100 : null,
    yieldOnValuePct: marketValue > 0 ? (ttm / marketValue) * 100 : null,
    costBasis,
    marketValue,
    bySymbol,
    monthlyPattern,
    projectedMonthly,
    projectedNext12m: ttm,
    incomeLagNote:
      "Projection = your recorded dividends from the last 12 months repeated, allocated by the months you actually received them. It is a run-rate, not an announced dividend forecast.",
    eventsLast12m: trailing.sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// ─── Fees ──────────────────────────────────────────────────────────────────

export interface FeeReport {
  totalFees: number;
  feesPctOfInvested: number | null;
  feesPctOfGrossPnl: number | null;
  annualDragPct: number | null;
  note: string;
}

export function feeReport(
  totalFees: number,
  invested: number,
  totalReturn: number,
  years: number,
): FeeReport {
  const grossPnl = totalReturn + totalFees;
  return {
    totalFees,
    feesPctOfInvested: invested > 0 ? (totalFees / invested) * 100 : null,
    feesPctOfGrossPnl: grossPnl > 0 ? (totalFees / grossPnl) * 100 : null,
    annualDragPct: invested > 0 && years > 0 ? (totalFees / invested / years) * 100 : null,
    note: "Fees are the ledger's recorded commissions and fee rows. Fund expense ratios are not in the ledger and are not estimated.",
  };
}

// ─── Goal planning ─────────────────────────────────────────────────────────

export interface GoalPlan {
  years: number;
  startValue: number;
  monthlyContribution: number;
  expectedReturnPct: number;
  inflationPct: number;
  nominalTarget: number | null;
  realTarget: number | null;
  projectedNominal: number;
  projectedReal: number;
  requiredMonthly: number | null;
  gap: number | null;
  onTrack: boolean | null;
  note: string;
}

function futureValue(start: number, monthly: number, years: number, annualPct: number): number {
  const months = Math.round(years * 12);
  const r = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
  if (Math.abs(r) < 1e-12) return start + monthly * months;
  const growth = Math.pow(1 + r, months);
  return start * growth + monthly * ((growth - 1) / r);
}

/** Deterministic compound projection with contributions, plus the required monthly saving. */
export function goalPlan(input: {
  startValue: number;
  monthlyContribution: number;
  years: number;
  expectedReturnPct: number;
  inflationPct?: number;
  target?: number | null;
}): GoalPlan {
  const inflation = input.inflationPct ?? 0;
  const projectedNominal = futureValue(input.startValue, input.monthlyContribution, input.years, input.expectedReturnPct);
  const projectedReal = projectedNominal / Math.pow(1 + inflation / 100, input.years);
  const realTarget = input.target != null ? input.target / Math.pow(1 + inflation / 100, input.years) : null;

  let requiredMonthly: number | null = null;
  if (input.target != null) {
    const months = Math.round(input.years * 12);
    const r = Math.pow(1 + input.expectedReturnPct / 100, 1 / 12) - 1;
    const growth = Math.pow(1 + r, months);
    const startGrowth = input.startValue * growth;
    if (months > 0 && growth > 1) {
      requiredMonthly = Math.max(0, (input.target - startGrowth) * r / (growth - 1));
    } else if (months > 0) {
      requiredMonthly = Math.max(0, (input.target - input.startValue) / months);
    }
  }

  return {
    years: input.years,
    startValue: input.startValue,
    monthlyContribution: input.monthlyContribution,
    expectedReturnPct: input.expectedReturnPct,
    inflationPct: inflation,
    nominalTarget: input.target ?? null,
    realTarget,
    projectedNominal,
    projectedReal,
    requiredMonthly,
    gap: input.target != null ? input.target - projectedNominal : null,
    onTrack: input.target != null ? projectedNominal >= input.target : null,
    note: "Deterministic compound growth at the assumed return — a planning input, not a forecast. The Monte-Carlo view shows the range around it.",
  };
}

/** First date a position can be topped up without disturbing a harvested loss. */
export function repurchaseAfter(soldDate: string): string {
  return addDays(soldDate, 31);
}
