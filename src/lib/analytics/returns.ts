// ─── Return measurement ────────────────────────────────────────────────────
//
// Three different questions, three different answers — each labelled:
//   • XIRR / money-weighted: what did *the investor's money* earn, given when
//     capital went in and came out? (deposits/withdrawals are the flows)
//   • TWR / time-weighted: what did the *strategy* earn, stripping out the
//     timing of contributions? (daily flow-adjusted, geometrically linked)
//   • Modified Dietz: the classic approximation when you only have period-end
//     values and dated flows. Reported as a cross-check, never as TWR.
//
// Conventions (documented in the UI and in AGENTS.md):
//   • XIRR discounts with an actual/365 exponent — the Excel convention.
//   • TWR links daily sub-period returns r = (V_t − CF_t)/V_{t−1} − 1, where CF
//     is the net *external* flow (deposit +, withdrawal −). Buys/sells are
//     internal and never appear here.
//   • Annualisation uses 252 observations for daily data. GIPS says not to
//     annualise periods shorter than a year, so anything under ~1 year is shown
//     as cumulative only.

import {
  DAYS_PER_YEAR,
  TRADING_DAYS,
  annualize,
  daysBetween,
  linkReturns,
  mean,
  sampleStd,
  yearsBetween,
} from "./stats";

export interface CashFlow {
  date: string;
  /** + into the portfolio (deposit), − out of it (withdrawal). */
  amount: number;
}

export interface DatedReturn {
  date: string;
  ret: number;
}

export interface DatedValue {
  date: string;
  value: number;
}

// ─── Money-weighted return (XIRR) ───────────────────────────────────────────

function npv(rate: number, flows: CashFlow[], t0: string): number {
  let v = 0;
  for (const f of flows) {
    const years = (Date.parse(f.date) - Date.parse(t0)) / (DAYS_PER_YEAR * 24 * 60 * 60 * 1000);
    v += f.amount / Math.pow(1 + rate, years);
  }
  return v;
}

/**
 * Annual money-weighted return from dated external cash flows.
 *
 * Investor perspective: contributions negative, withdrawals positive, and the
 * ending portfolio value as a final positive flow. Solves Σ CFᵢ/(1+r)^(tᵢ/365)=0
 * by bracketed bisection — Newton alone can wander when flows change sign more
 * than once, and a bracketed root is reproducible. Returns null when there is
 * no sign change (nothing was invested) or no bracket (pathological flows).
 */
export function xirr(flows: CashFlow[]): number | null {
  const usable = flows
    .filter((f) => Number.isFinite(f.amount) && f.amount !== 0 && Number.isFinite(Date.parse(f.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (usable.length < 2) return null;
  if (!usable.some((f) => f.amount < 0) || !usable.some((f) => f.amount > 0)) return null;

  const t0 = usable[0].date;
  // Scan a wide rate grid for a sign change; keep the smallest-magnitude
  // bracket so a multi-root series resolves to the economically sensible root.
  const grid: number[] = [];
  for (let r = -0.9999; r < -0.9; r += 0.01) grid.push(r);
  for (let r = -0.9; r <= 1; r += 0.02) grid.push(r);
  for (let r = 1.2; r <= 10; r += 0.2) grid.push(r);

  let foundLo: number | null = null;
  let foundHi: number | null = null;
  let prevRate = grid[0];
  let prevVal = npv(prevRate, usable, t0);
  for (let i = 1; i < grid.length; i++) {
    const rate = grid[i];
    const val = npv(rate, usable, t0);
    if (Number.isFinite(prevVal) && Number.isFinite(val) && Math.sign(prevVal) !== Math.sign(val)) {
      foundLo = prevRate;
      foundHi = rate;
      break;
    }
    prevRate = rate;
    prevVal = val;
  }
  if (foundLo === null || foundHi === null) return null;

  let loNumber = foundLo;
  let hiNumber = foundHi;
  for (let i = 0; i < 200; i++) {
    const mid: number = (loNumber + hiNumber) / 2;
    const val = npv(mid, usable, t0);
    if (!Number.isFinite(val)) return null;
    if (Math.abs(val) < 1e-9) return mid;
    const loVal = npv(loNumber, usable, t0);
    if (Math.sign(val) === Math.sign(loVal)) loNumber = mid;
    else hiNumber = mid;
  }
  return (loNumber + hiNumber) / 2;
}

// ─── Time-weighted return ──────────────────────────────────────────────────

/**
 * Daily time-weighted return series from a valuation series and dated external
 * flows. A flow on day t is assumed to happen during day t, so the day's
 * investment return is (V_t − CF_t)/V_{t−1} − 1.
 */
export function dailyTimeWeightedReturns(
  values: DatedValue[],
  flows: CashFlow[],
): DatedReturn[] {
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date));
  const flowByDate = new Map<string, number>();
  for (const f of flows) flowByDate.set(f.date, (flowByDate.get(f.date) ?? 0) + f.amount);

  const out: DatedReturn[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].value;
    const curr = sorted[i].value;
    if (!(prev > 0) || !Number.isFinite(curr)) continue;
    const flow = flowByDate.get(sorted[i].date) ?? 0;
    out.push({ date: sorted[i].date, ret: (curr - flow) / prev - 1 });
  }
  return out;
}

/**
 * Modified Dietz approximation for one period.
 *   R = (E − B − ΣCF) / (B + Σ wᵢCFᵢ),  wᵢ = (D − dᵢ)/D
 */
export function modifiedDietz(
  beginValue: number,
  endValue: number,
  flows: CashFlow[],
  periodStart: string,
  periodEnd: string,
): number | null {
  if (!(beginValue > 0)) return null;
  const totalDays = Math.max(1, daysBetween(periodStart, periodEnd));
  let netFlow = 0;
  let weightedFlow = 0;
  for (const f of flows) {
    if (f.date < periodStart || f.date > periodEnd) continue;
    netFlow += f.amount;
    const elapsed = daysBetween(periodStart, f.date);
    const w = Math.max(0, Math.min(1, (totalDays - elapsed) / totalDays));
    weightedFlow += w * f.amount;
  }
  const denom = beginValue + weightedFlow;
  if (!(denom > 0)) return null;
  return (endValue - beginValue - netFlow) / denom;
}

/** Cumulative TWR and its annualised form (null below one year). */
export function timeWeightedReturn(daily: DatedReturn[]): {
  cumulative: number | null;
  annualised: number | null;
  years: number;
} {
  const cumulative = linkReturns(daily.map((d) => d.ret));
  if (cumulative === null || daily.length < 2) return { cumulative, annualised: null, years: 0 };
  const years = yearsBetween(daily[0].date, daily[daily.length - 1].date);
  // GIPS: do not annualise a period shorter than a year — a one-week sample
  // would otherwise produce a meaningless triple-digit "annual" return.
  return { cumulative, annualised: years >= 1 ? annualize(cumulative, years) : null, years };
}

// ─── Period aggregation ────────────────────────────────────────────────────

export interface PeriodReturn {
  year: number;
  month: number; // 1..12
  ret: number;
}

/** Compound daily returns into calendar months. */
export function monthlyReturns(daily: DatedReturn[]): PeriodReturn[] {
  const buckets = new Map<string, number[]>();
  for (const d of daily) {
    const key = d.date.slice(0, 7);
    const arr = buckets.get(key) ?? [];
    arr.push(d.ret);
    buckets.set(key, arr);
  }
  const out: PeriodReturn[] = [];
  for (const [key, rets] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ret = linkReturns(rets);
    if (ret === null) continue;
    out.push({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), ret });
  }
  return out;
}

export interface YearReturn {
  year: number;
  ret: number;
  months: number;
}

/** Compound daily returns into calendar years, plus how many months contributed. */
export function yearlyReturns(daily: DatedReturn[]): YearReturn[] {
  const buckets = new Map<number, { rets: number[]; months: Set<string> }>();
  for (const d of daily) {
    const year = Number(d.date.slice(0, 4));
    const b = buckets.get(year) ?? { rets: [], months: new Set<string>() };
    b.rets.push(d.ret);
    b.months.add(d.date.slice(0, 7));
    buckets.set(year, b);
  }
  const out: YearReturn[] = [];
  for (const [year, b] of [...buckets.entries()].sort((a, b2) => a[0] - b2[0])) {
    const ret = linkReturns(b.rets);
    if (ret === null) continue;
    out.push({ year, ret, months: b.months.size });
  }
  return out;
}

/** Rolling annualised returns over a window of trading days. */
export function rollingReturns(
  values: DatedValue[],
  windowDays: number,
  stepDays = 5,
): Array<{ date: string; ret: number }> {
  const sorted = [...values].sort((a, b) => a.date.localeCompare(b.date));
  const out: Array<{ date: string; ret: number }> = [];
  for (let i = windowDays; i < sorted.length; i += stepDays) {
    const start = sorted[i - windowDays];
    const end = sorted[i];
    if (!(start.value > 0)) continue;
    const r = end.value / start.value - 1;
    const years = yearsBetween(start.date, end.date);
    const ann = annualize(r, years);
    if (ann !== null) out.push({ date: end.date, ret: ann });
  }
  return out;
}

// ─── Benchmark comparison ──────────────────────────────────────────────────

export interface BenchmarkComparison {
  benchmark: string;
  observations: number;
  portfolioReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  trackingErrorPct: number | null;
  informationRatio: number | null;
  upCapturePct: number | null;
  downCapturePct: number | null;
  hitRatePct: number | null;
}

/**
 * Align two daily return series by date and summarise active performance.
 * Up/down capture is the geometric return of the portfolio on days the
 * benchmark rose/fell, divided by the benchmark's return on those same days.
 */
export function compareToBenchmark(
  portfolio: DatedReturn[],
  benchmark: DatedReturn[],
  benchmarkSymbol: string,
): BenchmarkComparison {
  const benchByDate = new Map(benchmark.map((b) => [b.date, b.ret]));
  const pairs: Array<{ p: number; b: number; date: string }> = [];
  for (const p of portfolio) {
    const b = benchByDate.get(p.date);
    if (b === undefined) continue;
    pairs.push({ p: p.ret, b, date: p.date });
  }

  const pRet = linkReturns(pairs.map((x) => x.p));
  const bRet = linkReturns(pairs.map((x) => x.b));
  if (pairs.length < 2 || pRet === null || bRet === null) {
    return {
      benchmark: benchmarkSymbol,
      observations: pairs.length,
      portfolioReturnPct: pRet === null ? null : pRet * 100,
      benchmarkReturnPct: bRet === null ? null : bRet * 100,
      excessReturnPct: pRet !== null && bRet !== null ? (pRet - bRet) * 100 : null,
      trackingErrorPct: null,
      informationRatio: null,
      upCapturePct: null,
      downCapturePct: null,
      hitRatePct: null,
    };
  }

  const active = pairs.map((x) => x.p - x.b);
  const activeMean = mean(active);
  const activeSd = sampleStd(active);
  const teAnnual = activeSd === null ? null : activeSd * Math.sqrt(TRADING_DAYS);
  const ir = activeMean !== null && teAnnual !== null && teAnnual > 0
    ? (activeMean * TRADING_DAYS) / teAnnual
    : null;

  const up = pairs.filter((x) => x.b > 0);
  const down = pairs.filter((x) => x.b < 0);
  const upP = linkReturns(up.map((x) => x.p));
  const upB = linkReturns(up.map((x) => x.b));
  const downP = linkReturns(down.map((x) => x.p));
  const downB = linkReturns(down.map((x) => x.b));

  return {
    benchmark: benchmarkSymbol,
    observations: pairs.length,
    portfolioReturnPct: pRet * 100,
    benchmarkReturnPct: bRet * 100,
    excessReturnPct: (pRet - bRet) * 100,
    trackingErrorPct: teAnnual === null ? null : teAnnual * 100,
    informationRatio: ir,
    upCapturePct: upP !== null && upB !== null && upB !== 0 ? (upP / upB) * 100 : null,
    downCapturePct: downP !== null && downB !== null && downB !== 0 ? (downP / downB) * 100 : null,
    hitRatePct: pairs.length ? (pairs.filter((x) => x.p > x.b).length / pairs.length) * 100 : null,
  };
}
